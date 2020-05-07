const { authenticate } = require('@feathersjs/authentication');
const { Forbidden } = require('@feathersjs/errors');
const {
	iff, isProvider, discard, disallow, keepInArray,
} = require('feathers-hooks-common');
const { Configuration } = require('@schul-cloud/commons');

const { NODE_ENV, ENVIRONMENTS } = require('../../../../config/globals');
const logger = require('../../../logger');
const { equal } = require('../../../helper/compare').ObjectId;

const globalHooks = require('../../../hooks');
const { fileStorageTypes, SCHOOL_FEATURES } = require('../model');
const getFileStorageStrategy = require('../../fileStorage/strategies').createStrategy;

const { yearModel: Year } = require('../model');
const SchoolYearFacade = require('../logic/year');

let years = null;

const isTeamCreationByStudentsEnabled = (currentSchool) => {
	const { enableStudentTeamCreation } = currentSchool;
	const STUDENT_TEAM_CREATION_SETTING = Configuration.get('STUDENT_TEAM_CREATION');
	let isTeamCreationEnabled = false;
	switch (STUDENT_TEAM_CREATION_SETTING) {
		case 'enabled':
			// if enabled student team creation feature should be enabled
			isTeamCreationEnabled = true;
			break;
		case 'disabled':
			// if disabled student team creation feature should be disabled
			isTeamCreationEnabled = false;
			return false;
		case 'opt-in':
			// if opt-in student team creation should be enabled by admin
			isTeamCreationEnabled = enableStudentTeamCreation === 'true';
			break;
		case 'opt-out':
			// if opt-out student team creation should be disabled by admin
			isTeamCreationEnabled = enableStudentTeamCreation !== 'false';
			break;
		default:
			break;
	}
	return isTeamCreationEnabled;
};

const setStudentsCanCreateTeams = async (context) => {
	context.result.data.forEach((school) => {
		school.isTeamCreationByStudentsEnabled = isTeamCreationByStudentsEnabled(school);
	});
};

const expectYearsDefined = async () => {
	if (!years) {
		// default years will be cached after first call
		years = await Year.find().lean().exec();
	}
	return years;
};

const getDefaultFileStorageType = () => {
	if (!fileStorageTypes || !fileStorageTypes.length) {
		return undefined;
	}
	return fileStorageTypes[0];
};

const setDefaultFileStorageType = (hook) => {
	const storageType = getDefaultFileStorageType();
	hook.data.fileStorageType = storageType;
	return Promise.resolve(hook);
};

const setCurrentYearIfMissing = async (hook) => {
	if (!hook.data.currentYear) {
		await expectYearsDefined();
		const facade = new SchoolYearFacade(years, hook.data);
		hook.data.currentYear = facade.defaultYear;
	}
	return Promise.resolve(hook);
};

const createDefaultStorageOptions = (hook) => {
	// create buckets only in production mode
	if (NODE_ENV !== ENVIRONMENTS.PRODUCTION) {
		return Promise.resolve(hook);
	}
	const storageType = getDefaultFileStorageType();
	const schoolId = hook.result._id;
	const fileStorageStrategy = getFileStorageStrategy(storageType);
	return fileStorageStrategy.create(schoolId)
		.then(() => Promise.resolve(hook))
		.catch((err) => {
			if (err && err.code === 'BucketAlreadyOwnedByYou') {
				// The bucket already exists
				return Promise.resolve(hook);
			}
			return Promise.reject(err);
		});
};


const decorateYears = async (context) => {
	await expectYearsDefined();
	const addYearsToSchool = (school) => {
		const facade = new SchoolYearFacade(years, school);
		school.years = facade.toJSON();
	};
	try {
		switch (context.method) {
			case 'find':
				context.result.data.forEach((school) => {
					addYearsToSchool(school);
				});
				break;
			case 'get':
				addYearsToSchool(context.result);
				break;
			default:
				throw new Error('method not supported');
		}
	} catch (error) {
		logger.error(error);
	}
	return context;
};

const updatesArray = (key) => (key === '$push' || key === '$pull');
const updatesChat = (key, data) => {
	const chatFeatures = [
		SCHOOL_FEATURES.ROCKET_CHAT,
		SCHOOL_FEATURES.MESSENGER,
		SCHOOL_FEATURES.MESSENGER_SCHOOL_ROOM,
	];
	return updatesArray(key) && chatFeatures.indexOf(data[key].features) !== -1;
};
const updatesTeamCreation = (key, data) => updatesArray(key)
	&& !isTeamCreationByStudentsEnabled(data[key]);

const hasEditPermissions = async (context) => {
	try {
		const user = await globalHooks.getUser(context);
		if (user.permissions.includes('SCHOOL_EDIT')) {
			// SCHOOL_EDIT includes all of the more granular permissions below
			return context;
		}
		// if the user does not have SCHOOL_EDIT permissions, reduce the patch to the fields
		// the user is allowed to edit
		const patch = {};
		for (const key of Object.keys(context.data)) {
			if (
				(user.permissions.includes('SCHOOL_CHAT_MANAGE') && updatesChat(key, context.data))
				|| (user.permissions.includes('SCHOOL_STUDENT_TEAM_MANAGE') && updatesTeamCreation(key, context.data))
				|| (user.permissions.includes('SCHOOL_LOGO_MANAGE') && key === 'logo_dataUrl')
			) {
				patch[key] = context.data[key];
			}
		}
		context.data = patch;
		return context;
	} catch (err) {
		logger.error('Failed to check school edit permissions', err);
		throw new Forbidden('You don\'t have the necessary permissions to patch these fields');
	}
};

const restrictToUserSchool = async (context) => {
	const isSuperHero = await globalHooks.hasRole(context, context.params.account.userId, 'superhero');
	if (isSuperHero || equal(context.id, context.params.account.schoolId)) {
		return context;
	}
	throw new Forbidden('You can only edit your own school.');
};

const populateInQuery = (context) => (context.params.query || {}).$populate;

exports.before = {
	all: [],
	find: [],
	get: [],
	create: [
		authenticate('jwt'),
		globalHooks.hasPermission('SCHOOL_CREATE'),
		setDefaultFileStorageType,
		setCurrentYearIfMissing,
	],
	update: [
		authenticate('jwt'),
		globalHooks.hasPermission('SCHOOL_EDIT'),
		globalHooks.ifNotLocal(globalHooks.lookupSchool),
		globalHooks.ifNotLocal(restrictToUserSchool),
	],
	patch: [
		authenticate('jwt'),
		globalHooks.ifNotLocal(hasEditPermissions),
		globalHooks.ifNotLocal(globalHooks.lookupSchool),
		globalHooks.ifNotLocal(restrictToUserSchool),
	],
	/* It is disabled for the moment, is added with new "Löschkonzept"
    remove: [authenticate('jwt'), globalHooks.hasPermission('SCHOOL_CREATE')]
    */
	remove: [disallow()],
};

exports.after = {
	all: [
		iff(populateInQuery, keepInArray('systems', ['_id', 'type', 'alias', 'ldapConfig.active'])),
		iff(isProvider('external') && !globalHooks.isSuperHero(), discard('storageProvider')),
	],
	find: [decorateYears, setStudentsCanCreateTeams],
	get: [decorateYears, setStudentsCanCreateTeams],
	create: [createDefaultStorageOptions],
	update: [],
	patch: [],
	remove: [],
};
