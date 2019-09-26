const queryString = require('querystring');
const logger = require('winston');
const service = require('feathers-mongoose');
const link = require('./link-model');
const hooks = require('./hooks');

module.exports = function setup() {
	const app = this;

	const options = {
		Model: link,
		paginate: {
			default: 10000,
			max: 10000,
		},
		lean: true,
	};

	const registrationLinkTimeoutDays = 30;

	let linkService = service(options);

	function verifyDate(date) {
		date = new Date(date);
		const currentDate = new Date();
		const diff = currentDate.getTime() - date.getTime();
		if (diff < registrationLinkTimeoutDays * 1000 * 3600 * 24) return true;
		return false;
	}

	function getFrontendUrl(){
		let backendUrl = process.env.HOST
		if(backendUrl){
			backendUrl = backendUrl.replace('api','')
		} else {
			return 'http://localhost:3100'
		}
	}

	function isLocalRegistrationLink(link) {
		let linkPrefix = getFrontendUrl() + '/registration/'
		console.log(linkPrefix);
		if(link.startsWith(linkPrefix)) return true;
		return false;
	}

	function redirectToTarget(req, res, next) {
		if (req.method === 'GET' && !req.query.target) { // capture these requests and issue a redirect
			const linkId = req.params.__feathersId;
			linkService.get(linkId)
				.then((data) => {
					if (data.data || req.query.includeShortId) {
						const [url, query] = data.target.split('?');
						const queryObject = queryString.parse(query || '');
						queryObject.link = data._id;
						if (isLocalRegistrationLink(url) && !(verifyDate(data.createdAt))) {
							res.redirect(`${getFrontendUrl()}/link/expired`)
						} else {
							res.redirect(`${url}?${queryString.stringify(queryObject)}`);
						}
					} else {
						res.redirect(data.target);
					}
				})
				.catch((err) => {
					logger.warn(err);
					res.status(500).send(err);
				});
		} else {
			delete req.query.includeShortId;
			next();
		}
	}

	class RegistrationLinkService {
		constructor(options) {
			this.options = options || {};
			this.docs = {};
		}

		async create(data, params) {
			const linkData = {};
			if (data.toHash) {
				try {
					const user = (await app.service('users').find({ query: { email: data.toHash } }) || {}).data[0];
					if (user && user.importHash) linkData.hash = user.importHash;
					else {
						await app.service('hash').create(data).then((generatedHash) => {
							linkData.hash = generatedHash;
						});
					}
				} catch (err) {
					logger.warn(err);
					return Promise.reject(new Error(`Fehler beim Generieren des Hashes. ${err}`));
				}
			}

			// base link
			if (data.role === 'student') {
				linkData.link = `${(data.host || process.env.HOST)}/registration/${data.schoolId}`;
			} else {
				linkData.link = `${(data.host || process.env.HOST)}/registration/${data.schoolId}/byemployee`;
			}
			if (linkData.hash) linkData.link += `?importHash=${linkData.hash}`;

			// remove possible double-slashes in url except the protocol ones
			linkData.link = linkData.link.replace(/(https?:\/\/)|(\/)+/g, '$1$2');

			// generate short url
			await app.service('link').create({ target: linkData.link }).then((generatedShortLink) => {
				linkData.shortLink = `${(data.host || process.env.HOST)}/link/${generatedShortLink._id}`;
			}).catch((err) => {
				logger.warn(err);
				return Promise.reject(new Error('Fehler beim Erstellen des Kurzlinks.'));
			});

			// remove possible double-slashes in url except the protocol ones
			linkData.shortLink = linkData.shortLink.replace(/(https?:\/\/)|(\/)+/g, '$1$2');

			return linkData;
		}
	}

	class ExpertLinkService {
		constructor(options) {
			this.options = options || {};
			this.docs = {};
		}

		/**
         * Generates short expert invite link
         * @param data = object {
         *      role: user role = string "teamexpert"/"teamadministrator"
         *      host: current webaddress from client = string
         *      teamId: users teamId = string
         *      invitee: email of user who gets invited = string
         *      inviter: user id of user who generates the invite = ObjectId/string
         *      save: make hash link-friendly? = boolean (might be string)
         *  }
         */
		create(data, params) {
			return new Promise(async (resolve, reject) => {
				const linkInfo = {};
				const expertSchoolId = data.esid; const { email } = data; const
					{ teamId } = data;

				const hashService = app.service('hash');
				const linkService = app.service('link');

				if (email) {
					// generate import hash
					const user = (await app.service('users').find({ query: { email: data.toHash } }) || {}).data[0];
					if (user && user.importHash) linkInfo.hash = user.importHash;
					else {
						await hashService.create({
							toHash: email,
							save: true,
							patchUser: true,
						}).then((generatedHash) => {
							linkInfo.hash = generatedHash;
						}).catch((err) => {
							logger.warn(err);
							return Promise.resolve('Success!');
						});
					}
				}

				// build final link and remove possible double-slashes in url except the protocol ones
				if (expertSchoolId && linkInfo.hash) {
					// expert registration link for new users
					linkInfo.link = `${(data.host || process.env.HOST)}/registration/${expertSchoolId}/byexpert/?importHash=${linkInfo.hash}`.replace(/(https?:\/\/)|(\/)+/g, '$1$2');
				} else if (teamId) { /** @replaced logic is inside team services now * */
					// team accept link for existing users
					linkInfo.link = `${(data.host || process.env.HOST)}/teams/invitation/accept/${teamId}`.replace(/(https?:\/\/)|(\/)+/g, '$1$2');
				} else {
					logger.warn('Nicht alle Daten für den Experten-Link vorhanden.');
					return Promise.resolve('Success!');
				}

				// generate short url
				await linkService.create({ target: linkInfo.link }).then((generatedShortLink) => {
					linkInfo.shortLinkId = generatedShortLink._id;
					// build final short link and remove possible double-slashes in url except the protocol ones
					linkInfo.shortLink = `${(data.host || process.env.HOST)}/link/${generatedShortLink._id}`.replace(/(https?:\/\/)|(\/)+/g, '$1$2');
				}).catch((err) => {
					logger.warn('Fehler beim Erstellen des Kurzlinks.');
					return Promise.resolve('Success!');
				});

				resolve(linkInfo);
			});
		}
	}


	app.use('/link', redirectToTarget, linkService);
	app.use('/registrationlink', new RegistrationLinkService());
	app.use('/expertinvitelink', new ExpertLinkService());
	linkService = app.service('/link');
	linkService.hooks(hooks);
};
