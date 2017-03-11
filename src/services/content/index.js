'use strict';

const request = require('request-promise-native');
const hooks = require('./hooks');

class Service {
	constructor(options) {
		this.options = options || {};
	}

	find(params) {
		const serviceUrls = this.app.get('services') || {};
		const contentServerUrl = serviceUrls.content + "/contents";
		return request(contentServerUrl).then(string => {
			return JSON.parse(string);
		});
	}

	setup(app, path) {
		this.app = app;
	}

	/*get(id, params) {
	 return Promise.resolve({
	 id, text: `A new message with ID: ${id}!`
	 });
	 }*/
}

module.exports = function () {
	const app = this;

	// Initialize our service with any options it requires
	app.use('/contents', new Service());

	// Get our initialize service to that we can bind hooks
	const contentService = app.service('/contents');

	// Set up our before hooks
	contentService.before(hooks.before);

	// Set up our after hooks
	contentService.after(hooks.after);
};

module.exports.Service = Service;
