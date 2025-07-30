const ejs = require('ejs');
const path = require('path');

const renderemail = (templateName, data) => {
  const filePath = path.join(__dirname, '../..', 'templates', 'email', `${templateName}.ejs`);

  return new Promise((resolve, reject) => {
    ejs.renderFile(filePath, data, (err, html) => {
      if (err) return reject(err);
      resolve(html);
    });
  });
};

module.exports = renderemail;