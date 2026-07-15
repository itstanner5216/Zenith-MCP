function jsGreet(name) {
    return 'hi ' + name;
}

function jsShout(name) {
    return jsGreet(name) + jsGreet(name);
}

module.exports = { jsGreet, jsShout };
