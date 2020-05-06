const { promisify } = require('util');
const {
	BadRequest,
	Forbidden,
	NotFound,
	GeneralError,
	FeathersError,
} = require('@feathersjs/errors');
const { Configuration } = require('@schul-cloud/commons');
const lodash = require('lodash');
const jwt = require('jsonwebtoken');
const request = require('request-promise-native');

const { SCHOOL_FEATURES } = require('../school/model');

const videoconferenceHooks = require('./hooks');

const { getUser } = require('../../hooks');

const {
	copyPropertyNameIfIncludedInValuesFromSourceToTarget,
	isValidNotFoundResponse,
	isValidFoundResponse,
} = require('./logic/utils');

const server = require('./logic/server');
const {
	ensureMeetingExists,
	getMeetingInfo,
	joinMeeting,
} = require('./logic/server-helpers');

const {
	ROLES,
	PERMISSIONS,
	SCOPE_NAMES,
	RESPONSE_STATUS,
	STATES,
	CREATE_OPTION_TOGGLES,
} = require('./logic/constants');

const CLIENT_HOST = Configuration.get('HOST');
const SALT = Configuration.get('VIDEOCONFERENCE_SALT');

const VideoconferenceModel = require('./model');
const { schoolModel: Schools } = require('../school/model');

const { ObjectId } = require('../../helper/compare');

// event ids are from postgres instead of mongo
function scopeIdMatchesEventId(id) {
	return /^[0-9a-f-]{36}$/.test(id);
}

function idAndScopeNameAreValid(params) {
	return (ObjectId.isValid(params.scopeId) || scopeIdMatchesEventId(params.scopeId))
		&& Object.values(SCOPE_NAMES).includes(params.scopeName);
}

/**
 * Takes valid and enabled options and returns the enabled toggles
 * @param {*} options
 */
function getValidOptions(options = {}) {
	const validOptions = {};
	const toggleOptions = Object.values(CREATE_OPTION_TOGGLES);
	toggleOptions.forEach((option) => {
		copyPropertyNameIfIncludedInValuesFromSourceToTarget({
			source: options,
			propertyName: option,
			values: [true, false],
			target: validOptions,
			sourcePropertyNames: toggleOptions,
		});
	});
	return validOptions;
}

function throwOnValidationErrors(scopeId, scopeName, options = null) {
	if (!idAndScopeNameAreValid({ scopeId, scopeName })) {
		throw new BadRequest('id or scopeName invalid');
	}
	if (options !== null) {
		const validOptions = getValidOptions(options);
		if (!lodash.isEqual(options, validOptions)) {
			throw new BadRequest('options invalid'); // todo cleanup
		}
	}
}

/**
 * Checks if the school feature is enabled.
 *
 * @param {String} schoolId
 * @returns Boolean
 */
async function isSchoolFeatureEnabled(schoolId) {
	const school = await Schools.findById(schoolId).lean().exec();
	if (school && school.features && Array.isArray(school.features)) {
		return school.features.includes(SCHOOL_FEATURES.VIDEOCONFERENCE);
	}
	return false;
}

async function throwOnFeaturesDisabled(authenticatedUser) {
	// throw, if feature has not been enabled
	if (!Configuration.get('FEATURE_VIDEOCONFERENCE_ENABLED')) {
		throw new Forbidden('feature FEATURE_VIDEOCONFERENCE_ENABLED disabled');
	}
	// throw, if current users school feature is not enabled
	const schoolFeatureEnabled = await isSchoolFeatureEnabled(authenticatedUser.schoolId);
	if (!schoolFeatureEnabled) {
		throw new Forbidden('school feature disabled');
	}
}

/**
 * Returns true, if the array of userPermissions includes the desired permission, otherwise returns false.
 * @param {String} permission to test to be part of usersPermissions
 * @param {[String]} usersPermissions
 * @returns {Boolean}
 */
function userIsAllowedTo(permission, usersPermissions) {
	return usersPermissions.includes(permission);
}

function throwOnPermissionMissingInScope(permission, permissions) {
	if (!userIsAllowedTo(permission, permissions)) {
		throw new Forbidden(`permission ${permission} not given in scope`);
	}
}

function throwOnNotAnyPermissionInScope(requiredPermissions, scopePermissions) {
	if (scopePermissions.filter((permission) => requiredPermissions.includes(permission)).length === 0) {
		throw new Forbidden(`one permission of ${JSON.stringify(requiredPermissions)} required in scope`);
	}
}

function getUserRole(userPermissionsInScope) {
	if (userIsAllowedTo(PERMISSIONS.START_MEETING, userPermissionsInScope)) {
		return ROLES.MODERATOR;
	}
	if (userIsAllowedTo(PERMISSIONS.JOIN_MEETING, userPermissionsInScope)) {
		return ROLES.ATTENDEE;
	}
	throw new Error('no permission to start or join a videoconference');
}

/**
 *
 * @param {Object} app Express app
 * @param {*} user
 * @param {*} copeName
 * @param {*} scopeId
 */
async function getScopeInfo(app, user, scopeName, scopeId) {
	let scopeTitle;
	let event;
	let permissionScopeId;
	let permissionScopeName;
	// retrieve scope information, set roomName AND scopePermissionService OR throw
	switch (scopeName) {
		case (SCOPE_NAMES.COURSE):
			// fetch course metadata
			// eslint-disable-next-line prefer-destructuring
			permissionScopeId = scopeId;
			permissionScopeName = 'courses';
			scopeTitle = (await app.service(permissionScopeName).get(scopeId)).name;
			break;
		case (SCOPE_NAMES.EVENT):
			// eslint-disable-next-line no-case-declarations
			const events = (await app.service('calendar').find({
				query: { 'event-id': scopeId },
				payload: { userId: user.id },
			}));
			if (Array.isArray(events) && events.length >= 1) {
				event = events[0];
			} else {
				throw new NotFound('event not found');
			}

			permissionScopeId = event['x-sc-teamId'];
			if (!permissionScopeId) {
				throw new NotFound('could not find videoconference enabled for this event in team');
			}
			permissionScopeName = 'teams';
			scopeTitle = event.title;
			break;
		default:
			throw new BadRequest('invalid scope information given');
	}

	// check permissions and set role
	const scopePermissionService = app.service(`/${permissionScopeName}/:scopeId/userPermissions`);
	const { [user.id]: userPermissionsInScope } = await scopePermissionService.find({
		route: { scopeId: permissionScopeId },
		query: { userId: user.id },
	});

	let logoutURL = `${CLIENT_HOST}/${permissionScopeName}/${permissionScopeId}`;
	if (permissionScopeName === 'teams') logoutURL += '?activeTab=events';
	if (permissionScopeName === 'courses') logoutURL += '?activeTab=tools';

	return {
		scopeTitle,
		userPermissionsInScope,
		logoutURL,
	};
}

function getHighestVideoconferencePermission(permissions) {
	if (permissions.includes(PERMISSIONS.START_MEETING)) return PERMISSIONS.START_MEETING;
	if (permissions.includes(PERMISSIONS.JOIN_MEETING)) return PERMISSIONS.JOIN_MEETING;
	return null;
}

function createResponse(status, state, permissions, options = null, url) {
	const permission = getHighestVideoconferencePermission(permissions);
	return {
		status, state, permission, options, url,
	};
}

function getDefaultModel(scopeName, scopeId) {
	const collectionNameFor = (scope) => {
		if (scope === 'course') return 'courses';
		if (scope === 'event') return 'events';
		throw new Error();
	};
	return { targetModel: collectionNameFor(scopeName), target: scopeId };
}

/**
 * The videoconference "targetModel" values do not match the names used in file "refOwnerModel".
 * Hence we need to perform a mapping here to make them compatible.
 */
function getFileOwnerModelFromTargetModelName(targetModelName) {
	if (targetModelName === 'courses') return 'course';
	return targetModelName;
}

/**
 * Fetches the VideoconferenceModel with given scopeName and scopeId and returns it.
 * the model will be defined when a video conference is created/starts.
 * some of the options are reused from other users for join link generation
 *
 * @param {String} scopeName
 * @param {String} scopeId
 * @re
 */
async function getVideoconferenceMetadata(scopeName, scopeId, returnAsObject = false) {
	const modelDefaults = getDefaultModel(scopeName, scopeId);
	const videoconferenceMetadata = await VideoconferenceModel
		.findOne(modelDefaults)
		.exec();
	if (returnAsObject && videoconferenceMetadata !== null) {
		return videoconferenceMetadata.toObject();
	}
	return videoconferenceMetadata;
}

function getMeetingSetttings(logoutURL, { everyAttendeJoinsMuted = false }) {
	const settings = {
		allowStartStopRecording: false,
		lockSettingsDisablePrivateChat: true,
		logoutURL,
	};

	// http://docs.bigbluebutton.org/dev/api.html#create
	// autoStartRecording: ?
	// record: true

	// http://docs.bigbluebutton.org/dev/api.html#recording-ready-callback-url
	// meta_bbb-recording-ready-url

	settings.autoStartRecording = true;
	settings.record = true;
	settings['meta_bbb-recording-ready-url'] = 'http://dead74ee.ngrok.io/videoconference/recordings';

	if (everyAttendeJoinsMuted) {
		settings.muteOnStart = true;
	}

	return settings;
}

function getJoinSettings(userID, userPermissions, { moderatorMustApproveJoinRequests = false }) {
	const role = getUserRole(userPermissions);
	const settings = { userID };

	if (moderatorMustApproveJoinRequests && role !== ROLES.MODERATOR) {
		settings.guest = true;
	}

	return settings;
}

function getJoinRole(userPermissions, { everybodyJoinsAsModerator = false }) {
	return everybodyJoinsAsModerator ? ROLES.MODERATOR : getUserRole(userPermissions);
}

/**
 * @typedef {Object} VideoConference
 * @property {[url:Url]} the url to join the video conference
 * @property {[state:STATE]} the current state in which the video conference is in
 * @property {success:'SUCCESS'|'ERROR'} status indicator
 * @property {[permissions:[String]]} user permissions
 * @property {[error:String]} error message indication string
 */

/**
 * @typedef {Object} VideoconferenceOptions
 * @property {Boolean} [params.moderatorMustApproveJoinRequests=false]
 * - let moderators approve everybody who joins the video conference
 * @property {Boolean} [params.everybodyJoinsAsModerator=false] - let everybody join the video conference as moderator
 * @property {Boolean} [params.everyAttendeJoinsMuted=false] - let everybody except moderators join muted
 * @property {[String]} [params.rolesAllowedToAttendVideoconference] - scope roles who may attend the video conference
 * @property {[String]} [params.rolesAllowedToStartVideoconference] - scope role who may start the video conference
 */

/**
 * Creates or updates the VideoconferenceModel with given scopeName and scopeId
 * and returns it. The model will be defined when a video conference is
 * created/starts.
 *
 * Some of the options are reused from other users for join link generation.
 *
 * @param {String} scopeName
 * @param {String} scopeId
 * @param {*} options
 */
async function updateAndGetVideoconferenceMetadata(scopeName, scopeId, options) {
	const modelDefaults = getDefaultModel(scopeName, scopeId);
	let videoconferenceSettings = await getVideoconferenceMetadata(scopeName, scopeId);
	if (videoconferenceSettings === null) {
		videoconferenceSettings = await new VideoconferenceModel({
			...modelDefaults,
		});
	}
	const validOptions = getValidOptions(options);
	Object.assign(videoconferenceSettings.options, validOptions);
	await videoconferenceSettings.save();
	return videoconferenceSettings;
}

class GetVideoconferenceService {
	constructor(app) {
		this.app = app;
		this.docs = {};
	}

	/**
	 *
	 * @param {String} scopeId the id of a scope, the video conference is related to
	 * @param {Object} params
	 * @param {String} params.route.scopeName the scope name for given scope id
	 * @returns {VideoConference}
	 */
	async get(scopeId, params) {
		const { scopeName } = params.route;

		// PARAMETER VALIDATION ///////////////////////////////////////////////////
		throwOnValidationErrors(scopeId, scopeName);

		const { app } = this;
		const authenticatedUser = await getUser({ params, app });
		const { userPermissionsInScope } = await getScopeInfo(app, authenticatedUser, scopeName, scopeId);

		// CHECK PERMISSIONS //////////////////////////////////////////////////////
		await throwOnFeaturesDisabled(authenticatedUser);
		throwOnPermissionMissingInScope(
			PERMISSIONS.JOIN_MEETING, userPermissionsInScope,
		);

		// check video conference metadata have been already defined locally and video conference is running
		const videoconferenceMetadata = (await getVideoconferenceMetadata(scopeName, scopeId, true));
		const meetingInfo = await getMeetingInfo(server, scopeId);

		const hasStartPermission = userPermissionsInScope.includes(PERMISSIONS.START_MEETING);
		const hasOptions = videoconferenceMetadata !== null && videoconferenceMetadata.options !== undefined;

		if (isValidNotFoundResponse(meetingInfo)) {
			// meeting is not started yet or finihed --> wait (permission: join) or start (permission: start)
			const wasRunning = !!videoconferenceMetadata;
			return createResponse(
				RESPONSE_STATUS.SUCCESS,
				wasRunning ? STATES.FINISHED : STATES.NOT_STARTED,
				userPermissionsInScope,
				hasStartPermission && hasOptions ? videoconferenceMetadata.options : {},
			);
		}

		if (isValidFoundResponse(meetingInfo)) {
			return createResponse(
				RESPONSE_STATUS.SUCCESS,
				STATES.RUNNING,
				userPermissionsInScope,
				hasStartPermission && hasOptions ? videoconferenceMetadata.options : {},
			);
		}

		throw new GeneralError('could not fetch videoconference join url');
	}
}

class CreateVideoconferenceService {
	constructor(app) {
		this.app = app;
		this.docs = {};
	}

	/**
	 * Creates a video conference URL to join a meeting, inside a scope defined
	 * by id and scopeName, as moderator or attendee depending on permission.
	 *
	 * This may fail due insufficient permissions.
	 *
	 * @param {{scopeName:string, id:string}} data
	 * @param {VideoconferenceOptions} params
	 * @returns {CreateResponse} to authenticate through browser redirect
	 * @returns NotFound, if the video conference hasn't started yet and the user is not allowed to start it
	 * @returns Forbidden, if the user is not allowed to join or create the video conference or access this
	 * service while correct parameters are given or the feature is disabled
	 */
	async create(data = {}, params) {
		const { scopeName, scopeId, options = {} } = data;

		// PARAMETER VALIDATION ///////////////////////////////////////////////////
		throwOnValidationErrors(scopeId, scopeName, options);

		const { app } = this;
		const authenticatedUser = await getUser({ params, app });
		const { scopeTitle, userPermissionsInScope, logoutURL } = await getScopeInfo(
			app,
			authenticatedUser,
			scopeName,
			scopeId,
		);

		// CHECK PERMISSIONS //////////////////////////////////////////////////////
		await throwOnFeaturesDisabled(authenticatedUser);
		throwOnNotAnyPermissionInScope([
			PERMISSIONS.START_MEETING, PERMISSIONS.JOIN_MEETING,
		], userPermissionsInScope);

		// TODO if event... check team feature flag, ignore for courses
		// TODO check whether user "hasJoinPermission"?

		// BUSINESS LOGIC /////////////////////////////////////////////////////////

		try {
			let videoconferenceMetadata;

			const hasStartPermission = userPermissionsInScope.includes(PERMISSIONS.START_MEETING);

			if (hasStartPermission) {
				videoconferenceMetadata = (await updateAndGetVideoconferenceMetadata(scopeName, scopeId, options))
					.toObject();
			} else {
				videoconferenceMetadata = (await getVideoconferenceMetadata(scopeName, scopeId, true));
				if (videoconferenceMetadata === null) {
					return new NotFound('ask a moderator to start the videoconference, it\'s not started yet');
				}
			}

			const { options: conferenceOptions } = videoconferenceMetadata;
			const userID = authenticatedUser.id;

			// Get meeting info, create one if it does not exist and the user has sufficient privileges.
			const meetingSettings = getMeetingSetttings(logoutURL, conferenceOptions);
			const meeting = await ensureMeetingExists(server, scopeId, scopeTitle, meetingSettings, hasStartPermission);

			// Join the meeting.
			const settings = getJoinSettings(userID, userPermissionsInScope, conferenceOptions);
			const role = getJoinRole(userPermissionsInScope, conferenceOptions);
			const joinUrl = await joinMeeting(server, meeting, authenticatedUser.fullName, role, settings);

			return createResponse(
				RESPONSE_STATUS.SUCCESS,
				STATES.RUNNING,
				userPermissionsInScope,
				hasStartPermission ? videoconferenceMetadata.options : {},
				joinUrl,
			);
		} catch (error) {
			if (error instanceof FeathersError) {
				throw error;
			}
			throw new GeneralError(
				'join meeting link generation failed',
				{ errors: error },
			);
		}
	}
}

const jwtVerify = promisify(jwt.verify);

class RecordingReadyVideoconferenceService {
	constructor(app) {
		this.app = app;
		this.docs = {};
	}

	async create(data, params) {
		const { meeting_id: meetingId, record_id: recordId } = await jwtVerify(data.signed_parameters, SALT);

		const { response } = await server.recording.getRecordings({ recordId });
		const { recording } = response.recordings[0];
		const playbacks = recording.map((x) => x.playback[0].format[0]);

		console.log('Video ready:', meetingId, recordId);
		console.dir(playbacks, { depth: null });

		// TODO: Send AMQP (RabbitMQ) queue message

		// // Connect to the queue
		// const connection = await amqp.connect(AMQP_URI);
		// const channel = await connection.createChannel();

		// const payload = {
		// 	url:
		// 	'https://testbbb.schul-cloud.dev/playback/presentation/2.0/playback.html?meetingId=c7ae0ac13ace99c8b2239ce3919c28e47d5bbd2a-1588148082352',
		// 	duration: 10,
		// 	vid: '1234',
		// };

		// // Send messages to the queue
		// const buffer = Buffer.from(JSON.stringify(payload));
		// await channel.sendToQueue(AMQP_QUEUE, buffer, { persistent: true });

		// // Clean up
		// await channel.close();
		// await connection.close();


		return { ok: true };
	}
}

class RecordingUploadVideoconferenceService {
	constructor(app) {
		this.app = app;
		this.docs = {};
	}

	async create(data, params) {
		const { headers, route } = params;
		const { app } = this;

		// Verify the call was sent by the schulcloud-bbb-recorder service
		const [, token] = headers.authorization.split(' ');
		await jwtVerify(token, SALT);

		// Fetch videoconference model instance
		const conference = await VideoconferenceModel.findById(route.id).exec();

		const userId = '0000d231816abba584714c9e';

		const upload = app.service('fileStorage/signedUrl');
		const permissions = app.service('fileStorage/permission');
		const files = app.service('fileStorage');

		const fileName = 'test.webm';
		const fileType = 'video/webm';
		const parent = undefined;

		// Upload the file to the storage provider via a signed URL
		const target = await upload.create({ filename: fileName, fileType, parent }, { account: { userId } });

		await request({
			uri: target.url, method: 'PUT', headers: target.headers, body: data,
		});

		// Create an entry in the "files" collection
		const file = await files.create({
			name: fileName,
			owner: conference.target,
			refOwnerModel: getFileOwnerModelFromTargetModelName(conference.targetModel),
			type: fileType,
			size: data.length,
			storageFileName: target.header['x-amz-meta-flat-name'],
			thumbnail: target.header['x-amz-meta-thumbnail'],
			parent,
		}, { account: { userId } });

		// TODO: Delete recording in BBB
	}
}

module.exports = function setup(app) {
	app.use('/videoconference', new CreateVideoconferenceService(app));
	app.use('/videoconference/recordings', new RecordingReadyVideoconferenceService(app));
	app.use('/videoconference/:id/recordings', new RecordingUploadVideoconferenceService(app));
	app.use('/videoconference/:scopeName', new GetVideoconferenceService(app));

	const videoConferenceServices = [
		app.service('/videoconference'),
		app.service('/videoconference/:scopeName'),
	];

	videoConferenceServices.forEach((service) => service.hooks(videoconferenceHooks));
};
