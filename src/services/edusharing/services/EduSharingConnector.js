const REQUEST_TIMEOUT = 8000; // ms
const request = require('request-promise-native');
const { Configuration } = require('@schul-cloud/commons');
const { GeneralError } = require('@feathersjs/errors');
const logger = require('../../../logger');
const EduSearchResponse = require('./EduSearchResponse');

const ES_ENDPOINTS = {
	AUTH: `${Configuration.get('ES_DOMAIN')}/edu-sharing/rest/authentication/v1/validateSession`,
	NODE: `${Configuration.get('ES_DOMAIN')}/edu-sharing/rest/node/v1/nodes/mv-repo.schul-cloud.org/`,
	SEARCH: `${Configuration.get(
		'ES_DOMAIN'
	)}/edu-sharing/rest/search/v1/queriesV2/mv-repo.schul-cloud.org/mds/ngsearch/`,
};

const basicAuthorizationHeaders = {
	Authorization: `Basic ${Buffer.from(`${Configuration.get('ES_USER')}:${Configuration.get('ES_PASSWORD')}`).toString(
		'base64'
	)}`,
};

const eduSharingCookieValidity = 3600000; // 1h
let eduSharingCookieExpires = new Date();

class EduSharingConnector {
	constructor() {
		if (EduSharingConnector.instance) {
			return EduSharingConnector.instance;
		}

		EduSharingConnector.instance = this;
	}

	// gets cookie (JSESSION) for authentication when fetching images
	async getCookie() {
		const options = {
			uri: ES_ENDPOINTS.AUTH,
			method: 'GET',
			headers: basicAuthorizationHeaders,
			resolveWithFullResponse: true,
			json: true,
		};

		try {
			const result = await request(options);

			if (result.statusCode !== 200 || result.body.isValidLogin !== true) {
				throw Error('authentication error with edu sharing');
			}

			return result.headers['set-cookie'][0];
		} catch (e) {
			logger.error(`Couldn't get edusharing cookie: ${err.statusCode} ${err.message}`);
		}
	}

	async authorize() {
		const now = new Date();
		// should relogin if cookie expired
		if (now >= eduSharingCookieExpires) {
			try {
				this.eduSharingCookie = await this.getCookie();
				eduSharingCookieExpires = new Date(now.getTime() + eduSharingCookieValidity);
			} catch (e) {
				logger.error(`could not authorise edu-sharing request`, e);
				throw new GeneralError('Edu-Sharing Request failed');
			}
		}
	}

	async eduSharingRequest(options) {
		await this.authorize();

		try {
			return await request(options);
		} catch (e) {
			if (e.statusCode === 404) {
				return null;
			}
			logger.error(`Edu-Sharing Request failed with error ${e.statusCode} ${e.message}`, options);
			throw new GeneralError('Edu-Sharing Request failed');
		}
	}

	async getImage(url) {
		const options = {
			uri: url,
			method: 'GET',
			headers: {
				cookie: this.eduSharingCookie,
			},
			encoding: null, // necessary to get the image as binary value
			resolveWithFullResponse: true,
			// edu-sharing returns 302 to an error page instead of 403,
			// and the error page has wrong status codes
			followRedirect: false,
		};

		try {
			const result = await this.eduSharingRequest(options);
			const encodedData = `data:image;base64,${result.body.toString('base64')}`;
			return Promise.resolve(encodedData);
		} catch (err) {
			logger.error(`Failed fetching image ${url}`, err, options);
			return Promise.reject(err);
		}
	}

	async GET(id) {
		const propertyFilter = '-all-';

		const options = {
			method: 'GET',
			// eslint-disable-next-line max-len
			url: `${ES_ENDPOINTS.NODE}${id}/metadata?propertyFilter=${propertyFilter}`,
			headers: {
				Accept: 'application/json',
				'Content-type': 'application/json',
				...basicAuthorizationHeaders,
			},
			timeout: REQUEST_TIMEOUT,
		};

		const response = await this.eduSharingRequest(options);
		const parsed = JSON.parse(response);
		const { node } = parsed;
		if (node && node.preview && node.preview.url) {
			node.preview.url = await this.getImage(`${node.preview.url}&crop=true&maxWidth=1200&maxHeight=800`);
		}
		return node;
	}

	async FIND({ query: { searchQuery = '', $skip, $limit, sortProperties = 'score' } }) {
		const contentType = 'FILES';
		const maxItems = parseInt($limit, 10) || 9;
		const propertyFilter = '-all-'; // '-all-' for all properties OR ccm-stuff
		const skipCount = parseInt($skip, 10) || 0;
		const sortAscending = false;

		if (searchQuery.trim().length < 2) {
			return new EduSearchResponse();
		}

		const url = `${ES_ENDPOINTS.SEARCH}?${[
			`contentType=${contentType}`,
			`skipCount=${skipCount}`,
			`maxItems=${maxItems}`,
			`sortProperties=${sortProperties}`,
			`sortAscending=${sortAscending}`,
			`propertyFilter=${propertyFilter}`,
		].join('&')}`;

		const options = {
			method: 'POST',
			url,
			headers: {
				Accept: 'application/json',
				'Content-type': 'application/json',
				...basicAuthorizationHeaders,
			},
			body: JSON.stringify({
				criterias: [{ property: 'ngsearchword', values: [searchQuery.toLowerCase()] }],
				facettes: ['cclom:general_keyword'],
			}),
			timeout: REQUEST_TIMEOUT,
		};

		const response = await this.eduSharingRequest(options);
		const parsed = JSON.parse(response);
		if (parsed && parsed.nodes) {
			const promises = parsed.nodes.map(async (node) => {
				if (node.preview && node.preview.url) {
					node.preview.url = await this.getImage(`${node.preview.url}&crop=true&maxWidth=300&maxHeight=300`);
				}
			});
			await Promise.allSettled(promises);
		} else {
			return new EduSearchResponse();
		}

		return new EduSearchResponse(parsed);
	}

	static get Instance() {
		if (!EduSharingConnector.instance) {
			return new EduSharingConnector();
		}
		return EduSharingConnector.instance;
	}
}

module.exports = EduSharingConnector.Instance;
