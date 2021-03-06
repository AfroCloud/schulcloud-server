const { AuthenticationService, JWTStrategy } = require('@feathersjs/authentication');
const { LocalStrategy } = require('@feathersjs/authentication-local');
const { Configuration } = require('@schul-cloud/commons');
const { static: staticContent } = require('@feathersjs/express');
const path = require('path');

const { LdapStrategy, MoodleStrategy, IservStrategy, TSPStrategy, ApiKeyStrategy } = require('./strategies');
const { hooks } = require('./hooks');
const { authenticationSecret, audience } = require('./logic');

const authConfig = {
	entity: 'account',
	service: 'accountModel',
	secret: authenticationSecret,
	authStrategies: ['jwt', 'local', 'ldap', 'moodle', 'iserv', 'tsp', 'api-key'],
	jwtOptions: {
		header: { typ: 'access' },
		audience,
		issuer: 'feathers',
		algorithm: 'HS256',
		expiresIn: Configuration.get('JWT_LIFETIME'),
	},
	local: {
		usernameField: 'username',
		passwordField: 'password',
	},
	ldap: {
		usernameField: 'username',
	},
	moodle: {
		usernameField: 'username',
		systemIdField: 'systemId',
	},
	iserv: {
		usernameField: 'username',
		systemIdField: 'systemId',
	},
	tsp: {},
	'api-key': {},
};

class SCAuthenticationService extends AuthenticationService {
	async getPayload(authResult, params) {
		const payload = await super.getPayload(authResult, params);
		const user = await this.app.service('usersModel').get(authResult.account.userId);
		payload.schoolId = user.schoolId;
		payload.roles = user.roles;
		return payload;
	}
}

module.exports = (app) => {
	// Configure feathers-authentication
	app.set('authentication', authConfig);
	const authentication = new SCAuthenticationService(app);

	authentication.register('jwt', new JWTStrategy());
	authentication.register('local', new LocalStrategy());
	authentication.register('ldap', new LdapStrategy());
	authentication.register('moodle', new MoodleStrategy());
	authentication.register('iserv', new IservStrategy());
	authentication.register('tsp', new TSPStrategy());
	authentication.register('api-key', new ApiKeyStrategy());

	app.use('/authentication', authentication);

	const authenticationService = app.service('authentication');
	authenticationService.hooks(hooks);

	app.use('/authentication/api', staticContent(path.join(__dirname, '/docs')));
};
