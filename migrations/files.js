const database = require('../src/utils/database');
	database.connect();
		const [refOwnerModel, owner] = doc.key.split('/');