const setupNewsRepo = require('./repo');
const setupNewsUc = require('./uc');
const setupNewsSerivce = require('./service');

module.exports = function news2() {
	const app = this;

	setupNewsRepo(app);
	setupNewsUc(app);
	setupNewsSerivce(app);
};