// Motion Director — JSON for ExtendScript (ES3).
//
// A parser that never calls eval: request files are data, and data must not
// be able to run as code (some bridges fall back to eval("(" + text + ")")).
// Attached to $.global explicitly, because $.evalFile evaluates into the
// caller's scope rather than the global one.

$.global.MD_JSON = (function () {
    function Parser(text) {
        this.text = text;
        this.at = 0;
    }

    Parser.prototype.fail = function (message) {
        throw new Error("Invalid JSON at " + this.at + ": " + message);
    };

    Parser.prototype.white = function () {
        var c;
        while (this.at < this.text.length) {
            c = this.text.charAt(this.at);
            if (c === " " || c === "\t" || c === "\n" || c === "\r") {
                this.at += 1;
            } else {
                break;
            }
        }
    };

    Parser.prototype.value = function () {
        var c;
        this.white();
        c = this.text.charAt(this.at);
        if (c === "{") { return this.object(); }
        if (c === "[") { return this.array(); }
        if (c === "\"") { return this.string(); }
        if (c === "-" || (c >= "0" && c <= "9")) { return this.number(); }
        if (this.text.substr(this.at, 4) === "true") { this.at += 4; return true; }
        if (this.text.substr(this.at, 5) === "false") { this.at += 5; return false; }
        if (this.text.substr(this.at, 4) === "null") { this.at += 4; return null; }
        return this.fail("unexpected " + (c || "end of input"));
    };

    Parser.prototype.number = function () {
        var match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+\-]?[0-9]+)?/.exec(this.text.substr(this.at));
        if (!match) { return this.fail("bad number"); }
        this.at += match[0].length;
        return Number(match[0]);
    };

    Parser.prototype.string = function () {
        var out = "";
        var c;
        var hex;
        this.at += 1;
        while (this.at < this.text.length) {
            c = this.text.charAt(this.at);
            this.at += 1;
            if (c === "\"") { return out; }
            if (c === "\\") {
                c = this.text.charAt(this.at);
                this.at += 1;
                if (c === "u") {
                    hex = this.text.substr(this.at, 4);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex)) { this.fail("bad unicode escape"); }
                    out += String.fromCharCode(parseInt(hex, 16));
                    this.at += 4;
                } else if (c === "n") { out += "\n"; }
                else if (c === "r") { out += "\r"; }
                else if (c === "t") { out += "\t"; }
                else if (c === "b") { out += "\b"; }
                else if (c === "f") { out += "\f"; }
                else if (c === "\"" || c === "\\" || c === "/") { out += c; }
                else { this.fail("bad escape"); }
            } else {
                out += c;
            }
        }
        return this.fail("unterminated string");
    };

    Parser.prototype.array = function () {
        var out = [];
        this.at += 1;
        this.white();
        if (this.text.charAt(this.at) === "]") { this.at += 1; return out; }
        while (true) {
            out.push(this.value());
            this.white();
            if (this.text.charAt(this.at) === "]") { this.at += 1; return out; }
            if (this.text.charAt(this.at) !== ",") { this.fail("expected , or ]"); }
            this.at += 1;
        }
    };

    Parser.prototype.object = function () {
        var out = {};
        var key;
        this.at += 1;
        this.white();
        if (this.text.charAt(this.at) === "}") { this.at += 1; return out; }
        while (true) {
            this.white();
            if (this.text.charAt(this.at) !== "\"") { this.fail("expected a key"); }
            key = this.string();
            this.white();
            if (this.text.charAt(this.at) !== ":") { this.fail("expected :"); }
            this.at += 1;
            out[key] = this.value();
            this.white();
            if (this.text.charAt(this.at) === "}") { this.at += 1; return out; }
            if (this.text.charAt(this.at) !== ",") { this.fail("expected , or }"); }
            this.at += 1;
        }
    };

    function parse(text) {
        var parser = new Parser(String(text));
        var result = parser.value();
        parser.white();
        if (parser.at !== parser.text.length) { parser.fail("trailing characters"); }
        return result;
    }

    function quote(s) {
        var out = "\"";
        var i;
        var c;
        var code;
        var hex;
        for (i = 0; i < s.length; i += 1) {
            c = s.charAt(i);
            code = s.charCodeAt(i);
            if (c === "\"") { out += "\\\""; }
            else if (c === "\\") { out += "\\\\"; }
            else if (c === "\n") { out += "\\n"; }
            else if (c === "\r") { out += "\\r"; }
            else if (c === "\t") { out += "\\t"; }
            else if (code < 0x20 || code === 0x2028 || code === 0x2029) {
                hex = code.toString(16);
                while (hex.length < 4) { hex = "0" + hex; }
                out += "\\u" + hex;
            } else {
                out += c;
            }
        }
        return out + "\"";
    }

    function stringify(value) {
        var parts;
        var i;
        var key;
        var item;
        if (value === null || value === undefined) { return "null"; }
        if (typeof value === "number") { return isFinite(value) ? String(value) : "null"; }
        if (typeof value === "boolean") { return value ? "true" : "false"; }
        if (typeof value === "string") { return quote(value); }
        if (typeof value === "function") { return "null"; }
        if (value instanceof Array) {
            parts = [];
            for (i = 0; i < value.length; i += 1) { parts.push(stringify(value[i])); }
            return "[" + parts.join(",") + "]";
        }
        parts = [];
        for (key in value) {
            if (value.hasOwnProperty(key)) {
                item = value[key];
                if (item !== undefined && typeof item !== "function") {
                    parts.push(quote(key) + ":" + stringify(item));
                }
            }
        }
        return "{" + parts.join(",") + "}";
    }

    return { parse: parse, stringify: stringify };
}());
