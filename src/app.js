const express = require('@feathersjs/express');
const feathers = require('@feathersjs/feathers');
const configuration = require('@feathersjs/configuration');
const apiMetrics = require('prometheus-api-metrics');
const path = require('path');
const favicon = require('serve-favicon');
const compress = require('compression');
const cors = require('cors');
const rest = require('@feathersjs/express/rest');
const bodyParser = require('body-parser');
const socketio = require('@feathersjs/socketio');
const { ObjectId } = require('mongoose').Types;

const app = express(feathers());

const config = configuration();
app.configure(config);

const middleware = require('./middleware');
const sockets = require('./sockets');
const services = require('./services/');

const defaultHeaders = require('./middleware/defaultHeaders');
const handleResponseType = require('./middleware/handleReponseType');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');
const sentry = require('./middleware/sentry');
const rabbitMq = require('./utils/rabbitmq');

const { BODYPARSER_JSON_LIMIT, METRICS_PATH } = require('../config/globals');

const setupSwagger = require('./swagger');
const { initializeRedisClient } = require('./utils/redis');
const { setupAppHooks } = require('./app.hooks');
const versionService = require('./services/version');

const { requestInfo } = require('./logger/systemLogger');

const metricsOptions = {};
if (METRICS_PATH) {
	metricsOptions.metricsPath = METRICS_PATH;
}
app.use(apiMetrics(metricsOptions));

setupSwagger(app);
initializeRedisClient();
rabbitMq.setup(app);

// set custom response header for ha proxy
if (process.env.KEEP_ALIVE) {
	app.use((req, res, next) => {
		res.setHeader('Connection', 'Keep-Alive');
		next();
	});
}

app.use(compress())
	.options('*', cors())
	.use(cors())
	.use(favicon(path.join(app.get('public'), 'favicon.ico')))
	.use('/', express.static('public'))
	.configure(sentry)
	.use('/helpdesk', bodyParser.json({ limit: BODYPARSER_JSON_LIMIT }))
	.use('/', bodyParser.json())
	.use(bodyParser.urlencoded({ extended: true }))
	.use(bodyParser.raw({ type: () => true, limit: '10mb' }))
	.use(versionService)
	.use(defaultHeaders)
	.get('/system_info/haproxy', (req, res) => { res.send({ timestamp: new Date().getTime() }); })
	.get('/ping', (req, res) => { res.send({ message: 'pong', timestamp: new Date().getTime() }); })
	.configure(rest(handleResponseType))
	.configure(socketio())
	.configure(requestLogger)
	.use((req, res, next) => {
		// pass header into hooks.params
		// todo: To create a fake requestId on this place is a temporary solution
		// it MUST be removed after the API gateway is established
		const uid = ObjectId();
		req.headers.requestId = uid.toString();

		req.feathers.headers = req.headers;
		next();
	});

if (!['production', 'test'].includes(app.get('env'))) {
	// eslint-disable-next-line no-console
	console.info('set request logging for development');
	app.use((req, res, next) => {
		requestInfo(req);
		next();
	});
}

app.configure(services)
	.configure(sockets)
	.configure(middleware)
	.configure(setupAppHooks)
	.configure(errorHandler);

module.exports = app;
