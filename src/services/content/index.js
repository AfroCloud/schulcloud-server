'use strict';

const request = require('request-promise-native');
const hooks = require('./hooks');
const material = require('./material-model');
const service = require('feathers-mongoose');
const swaggerDocs = require('./docs/');

const REQUEST_TIMEOUT = 8000; // in ms

class ResourcesService {
	constructor(options) {
		this.options = options || {};
		this.docs = swaggerDocs.contentService.resourcesService;
	}

	find(params) {
		const serviceUrls = this.app.get('services') || {};
		const options = {
			uri: serviceUrls.content + '/resources/',
			qs: params.query,
			json: true,
			timeout: REQUEST_TIMEOUT
		};
		return request(options).then(message => {
			return message;
		});
	}

	get(id) {
		const serviceUrls = this.app.get('services') || {};
		const options = {
			uri: serviceUrls.content + '/resources/' + id,
			json: true,
			timeout: REQUEST_TIMEOUT
		};
		return request(options).then(message => {
			return message;
		});
	}

	setup(app, path) {
		this.app = app;
	}
}

class SearchService {
	constructor(options) {
		this.options = options || {};
		this.docs = swaggerDocs.contentService.searchService;
	}

	find(params) {
		const serviceUrls = this.app.get('services') || {};
		const options = {
			uri: serviceUrls.content + '/search/',
			qs: params.query,
			json: true,
			timeout: REQUEST_TIMEOUT
		};
		return request(options).then(message => {
			return message;
		});
	}

	setup(app, path) {
		this.app = app;
	}
}

class RedirectService {
	constructor(options) {
		this.options = options || {};
		this.docs = swaggerDocs.contentService.redirectService;
	}

	get(id) {
		const serviceUrls = this.app.get('services') || {};
		const options = {
			uri: serviceUrls.content + '/resources/' + id,
			json: true,
			timeout: REQUEST_TIMEOUT
		};
		return request(options).then(resource => {
			// Increase Click Counter
			request.patch(serviceUrls.content + '/resources/' + id, {
				json: {
					$inc: {
						clickCount: 1
					}
				}
			});
			return resource.url;
		});
	}

	static redirect(req, res, next) {
		res.redirect(res.data);
	}

	setup(app, path) {
		this.app = app;
	}
}

module.exports = function () {
	const app = this;

	// Initialize material model
	const options = {
		Model: material,
		paginate: {
			default: 10,
			max: 25
		},
		lean: true
	};

	// Initialize our service with options it requires
	var materialService = service(options);
	materialService.docs = swaggerDocs.materialService;

	app.use('/content/resources', new ResourcesService());
	app.use('/content/search', new SearchService());
	app.use('/content/redirect', new RedirectService(), RedirectService.redirect);
	app.use('/materials', materialService);

	// Get our initialize service to that we can bind hooks
	const resourcesService = app.service('/content/resources');
	const searchService = app.service('/content/search');

	// Set up our before hooks
	resourcesService.before(hooks.before);
	searchService.before(hooks.before);

	// Set up our after hooks
	resourcesService.after(hooks.after);
	searchService.after(hooks.after);
};
