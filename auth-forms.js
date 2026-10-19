function forms(html, url) {
    const { load } = require('cheerio');
    const document = load(html);
    return document('form').toArray().map(element => {
        const form = document(element);
        const fields = [];
        form.find('input').each((index, input) => {
            const field = document(input);
            if (field.attr('name')) fields.push({ name: field.attr('name'), type: field.attr('type') || 'text', value: field.attr('value') || '' });
        });
        return { action: new URL(form.attr('action') || url, url).href, method: (form.attr('method') || 'GET').toUpperCase(), fields };
    });
}

module.exports = { forms };