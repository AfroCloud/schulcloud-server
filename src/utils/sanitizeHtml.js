/* eslint-disable no-param-reassign */
const sanitizeHtml = require('sanitize-html');

const maxDeep = 12;
// enable html for all current editors
const keys = ['content', 'text', 'comment', 'gradeComment', 'description'];
const paths = ['lessons', 'news', 'newsModel', 'homework', 'submissions'];
const saveKeys = ['password', 'secret'];
const allowedTags = ['h1', 'h2', 'h3', 'blockquote', 'p', 'a', 'ul', 'ol', 's', 'u', 'span', 'del',
	'li', 'b', 'i', 'img', 'strong', 'em', 'strike', 'code', 'hr', 'br', 'div',
	'table', 'thead', 'caption', 'tbody', 'tr', 'th', 'td', 'pre', 'audio', 'video', 'sub', 'sup'];
const allowedSchemes = ['http', 'https', 'ftp', 'mailto'];

// const allowedSchemesByTag = {
// 	// allow base64 image data
// 	img: ['data'],
// };

const allowedAttributes = {
	a: ['href', 'name', 'target'],
	img: ['src', 'width', 'height', 'alt'],
};

const htmlTrueOptions = {
	allowedTags,
	allowedAttributes, // allow all attributes of allowed tags
	allowedSchemes,
	// allowedSchemesByTag, // TODO enable this?
	parser: {
		decodeEntities: true,
	},
	allowedStyles: {
		'*': {
			// Match HEX and RGB
			color: [/^#(0x)?[0-9a-f]+$/i, /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/],
			'text-align': [/^left$/, /^right$/, /^center$/],
			// Match any number with px, em, or %
			'font-size': [/^\d+(?:px|em|%)$/],
			'font-style': [/^\w+$/],
		},
	},
};

const htmlFalseOptions = {
	allowedTags: [], // disallow all tags
	allowedAttributes: [], // disallow all attributes
	allowedSchemes: [], // disallow url schemes
	parser: {
		decodeEntities: true,
	},
};

/**
 * sanitizes data
 * @param {*} data
 * @param {*} param
 */
const sanitize = (data, { html = false }) => {
	// https://www.npmjs.com/package/sanitize-html
	if (html === true) {
		// editor-content data
		data = sanitizeHtml(data, htmlTrueOptions);
		data = data.replace(/(&lt;script&gt;).*?(&lt;\/script&gt;)/gim, ''); // force remove script tags
		data = data.replace(/(<script>).*?(<\/script>)/gim, ''); // force remove script tags
	} else {
		// non editor-content data
		data = sanitizeHtml(data, htmlFalseOptions);
	}
	return data;
};

/**
 * disables sanitization for defined keys if a path is matching
 * @param {*} path
 * @param {*} key
 */
const allowedHtmlByPathAndKeys = (path, key) => paths.includes(path) && keys.includes(key);

/**
 * Strips JS/HTML Code from data and returns clean version of it
 * @param data {object/array/string}
 * @param path {string}
 * @param depth {number} -
 * @param safeAttributes {array} - attributes over which sanitization won't be performed
 * @returns data - clean without JS
 */
const sanitizeDeep = (data, path, depth = 0, safeAttributes = []) => {
	if (depth >= maxDeep) {
		throw new Error('Data level is to deep. (sanitizeDeep)', { path, data });
	}
	if (typeof data === 'object' && data !== null) {
		// we have an object, can match strings or recurse child objects
		// eslint-disable-next-line consistent-return
		Object.entries(data).forEach(([key, value]) => {
			if (typeof value === 'string') {
				// ignore values completely
				if (saveKeys.includes(key) || safeAttributes.includes(key)) {
					return data; // TODO:  why not over keys in allowedHtmlByPathAndKeys
				}
				data[key] = sanitize(value, { html: allowedHtmlByPathAndKeys(path, key) });
			} else {
				sanitizeDeep(value, path, depth + 1, safeAttributes);
			}
		});
	} else if (typeof data === 'string') {
		// here we can sanitize the input
		data = sanitize(data, { html: false });
	} else if (Array.isArray(data)) {
		// here we have to check all array elements and sanitize strings or do recursion
		for (let i = 0; i < data.length; i += 1) {
			if (typeof data[i] === 'string') {
				data[i] = sanitize(data[i], { html: false });
			} else {
				sanitizeDeep(data[i], path, depth + 1, safeAttributes);
			}
		}
	}
	return data;
};

module.exports = {
	sanitizeDeep,
	sanitizeConsts: {
		keys,
		paths,
		saveKeys,
		allowedTags,
		allowedSchemes,
		maxDeep,
	},
};
