// Motion Director — dispatcher, run inside After Effects for every request.
//
// Launched by `osascript … DoScript` on macOS (which first sets
// $.global.MOTION_DIRECTOR_MAILBOX) or by `AfterFX.exe -r` on Windows (which
// cannot pass data, so the mailbox is found in the shared temp folder).
//
// Contract:
//   1. Take the OLDEST request-<id>.json in the mailbox and DELETE it as it is
//      read, so no other run can execute it again.
//   2. Run the named operation from MD_OPS. Requests name operations and carry
//      data; they never carry code, and there is no eval of request content.
//   3. Changes run inside one undo group with dialogs suppressed.
//   4. Write response-<id>.json atomically (temp file, then rename).
//
// Nothing may escape to After Effects' error dialog: a modal blocks every
// later script until someone clicks it. Every failure is written as a
// response or, at worst, a log line.

(function motionDirectorDispatch() {
    var here = new File($.fileName).parent;
    var logFile = null;

    function describe(e) {
        // `"x" + e` itself throws in ExtendScript when e is an Error, and that
        // second exception escapes to a modal. Format every error through here.
        try {
            if (e === null || e === undefined) { return "unknown error"; }
            if (typeof e === "string") { return e; }
            var message = (e.message === undefined || e.message === null) ? "error" : String(e.message);
            if (e.line !== undefined && e.line !== null) { message += " (line " + String(e.line) + ")"; }
            return message;
        } catch (ignored) {
            return "unformattable error";
        }
    }

    function log(message) {
        if (logFile === null) { return; }
        try {
            logFile.encoding = "UTF-8";
            if (logFile.open("a")) {
                logFile.writeln("[" + new Date().toString() + "] " + message);
                logFile.close();
            }
        } catch (ignored) {}
    }

    function mailboxFolder() {
        var injected = null;
        try { injected = $.global.MOTION_DIRECTOR_MAILBOX; } catch (ignored) {}
        if (injected) { return new Folder(String(injected)); }
        return new Folder(Folder.temp.fsName + "/motion-director/mailbox");
    }

    function oldestRequest(folder) {
        var files = folder.getFiles("request-*.json");
        var best = null;
        var i;
        if (!files) { return null; }
        for (i = 0; i < files.length; i += 1) {
            if (files[i] instanceof File) {
                if (best === null || files[i].modified < best.modified) { best = files[i]; }
            }
        }
        return best;
    }

    function readText(file) {
        var text;
        file.encoding = "UTF-8";
        if (!file.open("r")) { throw new Error("cannot open " + file.name); }
        text = file.read();
        file.close();
        return text;
    }

    function writeResponse(folder, id, response) {
        var body;
        var tmp;
        var answer;
        try {
            body = $.global.MD_JSON.stringify(response);
        } catch (e) {
            body = "{\"id\":\"" + id + "\",\"ok\":false,\"phase\":\"" + response.phase +
                "\",\"result\":null,\"error\":\"the result could not be written\",\"logs\":[]}";
        }
        tmp = new File(folder.fsName + "/.response-" + id + ".json.tmp");
        tmp.encoding = "UTF-8";
        if (!tmp.open("w")) { log("cannot write response for " + id); return; }
        tmp.write(body);
        tmp.close();
        answer = new File(folder.fsName + "/response-" + id + ".json");
        if (answer.exists) { answer.remove(); }
        tmp.rename("response-" + id + ".json");
    }

    function run() {
        var folder = mailboxFolder();
        var requestFile;
        var name;
        var id;
        var raw;
        var request;
        var response;
        var op;
        var undoOpen = false;
        var suppressed = false;

        if (!folder.exists) { return; }
        logFile = new File(folder.fsName + "/dispatcher.log");
        requestFile = oldestRequest(folder);
        // Nothing pending: an earlier run already took it. Write nothing, or
        // we would overwrite that run's answer.
        if (requestFile === null) { return; }

        name = decodeURI(requestFile.name);
        id = name.substring("request-".length, name.length - ".json".length);
        response = { id: id, ok: false, phase: "dispatch", result: null, error: null, logs: [] };

        try {
            raw = readText(requestFile);
            if (!requestFile.remove()) { log("could not consume " + name); }
        } catch (e) {
            response.error = "could not read the request: " + describe(e);
            writeResponse(folder, id, response);
            return;
        }

        try {
            $.evalFile(new File(here.fsName + "/json.jsx"));
            $.evalFile(new File(here.fsName + "/ops.jsx"));
            request = $.global.MD_JSON.parse(raw);
        } catch (e) {
            response.error = "could not start: " + describe(e);
            writeResponse(folder, id, response);
            return;
        }

        if (request.id !== id) {
            response.error = "request id does not match its file name";
            writeResponse(folder, id, response);
            return;
        }
        op = $.global.MD_OPS[request.op];
        if (typeof op !== "function" || !$.global.MD_OPS.hasOwnProperty(request.op)) {
            response.error = "unknown operation: " + String(request.op);
            writeResponse(folder, id, response);
            return;
        }

        response.phase = "execute";
        try {
            if (request.mutates) {
                try { app.beginSuppressDialogs(); suppressed = true; } catch (ignored) {}
                app.beginUndoGroup("Motion Director: " + String(request.label || request.op));
                undoOpen = true;
            }
            response.result = op(request.args || {}, function (message) { response.logs.push(String(message)); });
            if (response.result === undefined) { response.result = null; }
            response.ok = true;
        } catch (e) {
            response.ok = false;
            response.error = describe(e);
            // Operations that restore what they touched before rethrowing mark
            // the error, so the server knows nothing was left half-done.
            try { if (e.mdRolledBack === true) { response.rolledBack = true; } } catch (ignored) {}
        } finally {
            if (undoOpen) { try { app.endUndoGroup(); } catch (ignored) {} }
            // false: do not replay suppressed alerts, which would be a modal.
            if (suppressed) { try { app.endSuppressDialogs(false); } catch (ignored) {} }
        }
        writeResponse(folder, id, response);
    }

    try {
        run();
    } catch (e) {
        log("dispatcher failed: " + describe(e));
    }
}());
