// Motion Director — the operations the dispatcher may run (ES3).
//
// Every operation takes plain JSON arguments and returns plain JSON. Layers
// and comps are addressed by After Effects' stable ids, never by index,
// because an index changes the moment a layer is moved. Properties are
// addressed by matchName, which does not change with the interface language.

$.global.MD_OPS = (function () {
    var REHEARSAL_MARK = "motion-director-rehearsal";
    var REHEARSAL_FOLDER = "Motion Director Rehearsals";
    var MAX_DEPTH = 12;

    // ---------- lookups ----------

    function compById(id) {
        var item = app.project.itemByID(Number(id));
        if (!item || !(item instanceof CompItem)) { throw new Error("There is no comp with id " + id + "."); }
        return item;
    }

    function layerById(comp, id) {
        var i;
        for (i = 1; i <= comp.numLayers; i += 1) {
            if (comp.layer(i).id === Number(id)) { return comp.layer(i); }
        }
        throw new Error("There is no layer with id " + id + " in \"" + comp.name + "\".");
    }

    function propertyByPath(layer, path) {
        var current = layer;
        var i;
        for (i = 0; i < path.length; i += 1) {
            current = current.property(path[i]);
            if (!current) { throw new Error("\"" + layer.name + "\" has no property " + path.join(" > ") + "."); }
        }
        return current;
    }

    // ---------- values ----------

    function isNumeric(property) {
        var t = property.propertyValueType;
        return t === PropertyValueType.OneD || t === PropertyValueType.TwoD || t === PropertyValueType.ThreeD ||
            t === PropertyValueType.TwoD_SPATIAL || t === PropertyValueType.ThreeD_SPATIAL || t === PropertyValueType.COLOR;
    }

    function toVec(value) {
        var out = [];
        var i;
        if (value instanceof Array) {
            for (i = 0; i < value.length; i += 1) { out.push(Number(value[i])); }
            return out;
        }
        return [Number(value)];
    }

    function fromVec(vec, dimensions) {
        return dimensions === 1 ? vec[0] : vec;
    }

    function interpolationName(type) {
        if (type === KeyframeInterpolationType.HOLD) { return "hold"; }
        if (type === KeyframeInterpolationType.BEZIER) { return "bezier"; }
        return "linear";
    }

    function interpolationType(name) {
        if (name === "hold") { return KeyframeInterpolationType.HOLD; }
        if (name === "bezier") { return KeyframeInterpolationType.BEZIER; }
        return KeyframeInterpolationType.LINEAR;
    }

    function easeList(eases) {
        var out = [];
        var i;
        for (i = 0; i < eases.length; i += 1) { out.push({ speed: eases[i].speed, influence: eases[i].influence }); }
        return out;
    }

    function keyframeEases(list) {
        var out = [];
        var i;
        for (i = 0; i < list.length; i += 1) { out.push(new KeyframeEase(Number(list[i].speed), Number(list[i].influence))); }
        return out;
    }

    // ---------- reading keys ----------

    function readKeys(property) {
        var keys = [];
        var i;
        var key;
        for (i = 1; i <= property.numKeys; i += 1) {
            key = {
                time: property.keyTime(i),
                value: toVec(property.keyValue(i)),
                inInterpolation: interpolationName(property.keyInInterpolationType(i)),
                outInterpolation: interpolationName(property.keyOutInterpolationType(i)),
                inEase: easeList(property.keyInTemporalEase(i)),
                outEase: easeList(property.keyOutTemporalEase(i)),
                temporalContinuous: property.keyTemporalContinuous(i),
                temporalAutoBezier: property.keyTemporalAutoBezier(i)
            };
            if (property.isSpatial) {
                key.inTangent = toVec(property.keyInSpatialTangent(i));
                key.outTangent = toVec(property.keyOutSpatialTangent(i));
                key.spatialContinuous = property.keySpatialContinuous(i);
                key.spatialAutoBezier = property.keySpatialAutoBezier(i);
                key.roving = property.keyRoving(i);
            }
            keys.push(key);
        }
        return keys;
    }

    function hasExpression(property) {
        try {
            return property.canSetExpression && property.expressionEnabled && property.expression !== "";
        } catch (ignored) {
            return false;
        }
    }

    function collectAnimated(group, path, depth, out) {
        var i;
        var child;
        var childPath;
        if (depth > MAX_DEPTH) { return; }
        for (i = 1; i <= group.numProperties; i += 1) {
            child = group.property(i);
            if (!child) { continue; }
            childPath = path.concat([child.matchName]);
            if (child.propertyType === PropertyType.PROPERTY) {
                if (child.canVaryOverTime && isNumeric(child) && (child.numKeys > 0 || hasExpression(child))) {
                    out.push({ property: child, path: childPath });
                }
            } else {
                collectAnimated(child, childPath, depth + 1, out);
            }
        }
    }

    function describeLayer(layer, properties) {
        return {
            id: layer.id,
            index: layer.index,
            name: layer.name,
            type: layer.matchName,
            inPoint: layer.inPoint,
            outPoint: layer.outPoint,
            parentId: layer.parent ? layer.parent.id : null,
            enabled: layer.enabled,
            properties: properties
        };
    }

    // ---------- writing keys ----------

    function writeKeys(property, keys) {
        var i;
        var index;
        var key;
        var dimensions;
        for (i = property.numKeys; i >= 1; i -= 1) { property.removeKey(i); }
        if (keys.length === 0) { return; }
        dimensions = keys[0].value.length;
        // Add every key first, in time order, so indices are final before
        // any attribute is set on them.
        for (i = 0; i < keys.length; i += 1) {
            index = property.addKey(Number(keys[i].time));
            property.setValueAtKey(index, fromVec(keys[i].value, dimensions));
        }
        for (i = 0; i < keys.length; i += 1) {
            key = keys[i];
            index = i + 1;
            property.setInterpolationTypeAtKey(index, interpolationType(key.inInterpolation), interpolationType(key.outInterpolation));
            if (key.inEase.length > 0 && key.outEase.length > 0) {
                property.setTemporalEaseAtKey(index, keyframeEases(key.inEase), keyframeEases(key.outEase));
            }
            property.setTemporalContinuousAtKey(index, key.temporalContinuous === true);
            property.setTemporalAutoBezierAtKey(index, key.temporalAutoBezier === true);
            if (property.isSpatial && key.inTangent && key.outTangent) {
                property.setSpatialTangentsAtKey(index, key.inTangent, key.outTangent);
                property.setSpatialContinuousAtKey(index, key.spatialContinuous === true);
                property.setSpatialAutoBezierAtKey(index, key.spatialAutoBezier === true);
            }
        }
        // Roving is only valid on inner spatial keys, and only once the rest is set.
        if (property.isSpatial) {
            for (i = 1; i < keys.length - 1; i += 1) {
                if (keys[i].roving === true) { property.setRovingAtKey(i + 1, true); }
            }
        }
    }

    function sameKeys(a, b) {
        var i;
        var j;
        if (a.length !== b.length) { return false; }
        for (i = 0; i < a.length; i += 1) {
            if (Math.abs(a[i].time - b[i].time) > 0.0001) { return false; }
            if (a[i].value.length !== b[i].value.length) { return false; }
            for (j = 0; j < a[i].value.length; j += 1) {
                if (Math.abs(a[i].value[j] - b[i].value[j]) > 0.001 * Math.max(1, Math.abs(a[i].value[j]))) { return false; }
            }
        }
        return true;
    }

    function refused(message) {
        var e = new Error(message);
        e.mdRolledBack = true;
        return e;
    }

    function rehearsalFolder() {
        var i;
        var item;
        for (i = 1; i <= app.project.numItems; i += 1) {
            item = app.project.item(i);
            if (item instanceof FolderItem && item.name === REHEARSAL_FOLDER) { return item; }
        }
        return app.project.items.addFolder(REHEARSAL_FOLDER);
    }

    function isRehearsal(comp) {
        return String(comp.comment).indexOf(REHEARSAL_MARK) === 0;
    }

    // ---------- operations ----------

    return {
        ping: function () {
            var active = app.project.activeItem;
            var file = app.project.file;
            return {
                afterEffects: app.version,
                project: { name: file ? file.displayName : "Untitled Project", path: file ? file.fsName : null },
                activeComp: (active instanceof CompItem) ? { id: active.id, name: active.name } : null
            };
        },

        list_comps: function () {
            var out = [];
            var i;
            var item;
            for (i = 1; i <= app.project.numItems; i += 1) {
                item = app.project.item(i);
                if (item instanceof CompItem && !isRehearsal(item)) {
                    out.push({ id: item.id, name: item.name, width: item.width, height: item.height, frameRate: item.frameRate, duration: item.duration, layers: item.numLayers });
                }
            }
            return out;
        },

        // Every animated numeric property of every layer: its exact keys and its
        // value at every frame of the range, as the comp plays (expressions
        // included). Capped by a sample budget, and says so when it is.
        read_comp: function (args) {
            var comp = compById(args.compId);
            var fps = comp.frameRate;
            var start = (typeof args.start === "number") ? args.start : comp.workAreaStart;
            var end = (typeof args.end === "number") ? args.end : comp.workAreaStart + comp.workAreaDuration;
            var budget = (typeof args.maxSamples === "number") ? args.maxSamples : 40000;
            var frames = Math.floor((end - start) * fps + 0.000001) + 1;
            var found = [];
            var perLayer = [];
            var i;
            var j;
            var f;
            var layer;
            var animated;
            var tracks;
            var item;
            var samples;
            var truncated = null;
            var total = 0;

            for (i = 1; i <= comp.numLayers; i += 1) {
                layer = comp.layer(i);
                animated = [];
                collectAnimated(layer, [], 0, animated);
                perLayer.push({ layer: layer, animated: animated });
                total += animated.length;
            }
            if (total > 0 && total * frames > budget) {
                frames = Math.max(2, Math.floor(budget / total));
                truncated = { reason: "Sampling was capped to keep After Effects responsive.", sampledUntil: start + (frames - 1) / fps };
            }

            for (i = 0; i < perLayer.length; i += 1) {
                tracks = [];
                for (j = 0; j < perLayer[i].animated.length; j += 1) {
                    item = perLayer[i].animated[j];
                    samples = [];
                    for (f = 0; f < frames; f += 1) { samples.push(toVec(item.property.valueAtTime(start + f / fps, false))); }
                    tracks.push({
                        path: item.path,
                        name: item.property.name,
                        dimensions: samples.length ? samples[0].length : 1,
                        spatial: item.property.isSpatial === true,
                        keys: readKeys(item.property),
                        expression: hasExpression(item.property)
                            ? { text: item.property.expression, enabled: true, error: item.property.expressionError || null }
                            : undefined,
                        samples: samples
                    });
                }
                found.push(describeLayer(perLayer[i].layer, tracks));
            }

            return {
                compId: comp.id,
                name: comp.name,
                width: comp.width,
                height: comp.height,
                frameRate: fps,
                duration: comp.duration,
                sampleStart: start,
                sampleCount: frames,
                layers: found,
                truncated: truncated || undefined
            };
        },

        // A copy to rehearse a change on. Marked and filed so it can never be
        // mistaken for the designer's own work, and only such copies can be deleted.
        duplicate_comp: function (args) {
            var original = compById(args.compId);
            var copy = original.duplicate();
            var map = [];
            var i;
            copy.name = original.name + " — " + String(args.label || "rehearsal");
            copy.comment = REHEARSAL_MARK + " of " + original.id;
            copy.parentFolder = rehearsalFolder();
            for (i = 1; i <= original.numLayers; i += 1) { map.push([original.layer(i).id, copy.layer(i).id]); }
            return { compId: copy.id, name: copy.name, layerMap: map };
        },

        delete_rehearsal: function (args) {
            var comp = compById(args.compId);
            if (!isRehearsal(comp)) { throw refused("\"" + comp.name + "\" is not a Motion Director rehearsal, so it was left alone."); }
            comp.remove();
            return { deleted: true };
        },

        // Replace the keys of each property with the given list. With `expect`,
        // refuses before touching anything if the current keys differ (someone
        // edited them since they were read). If anything fails partway, every
        // property already touched is put back as it was.
        set_keys: function (args) {
            var comp = compById(args.compId);
            var edits = args.edits;
            var resolved = [];
            var touched = [];
            var i;
            var property;
            var layer;
            var drifted = [];
            var restoredAll = true;
            var failure;

            for (i = 0; i < edits.length; i += 1) {
                try {
                    layer = layerById(comp, edits[i].layerId);
                    property = propertyByPath(layer, edits[i].path);
                } catch (e) {
                    throw refused(e.message);
                }
                if (edits[i].expect && !sameKeys(readKeys(property), edits[i].expect)) {
                    drifted.push(layer.name + " › " + property.name);
                }
                resolved.push(property);
            }
            if (drifted.length > 0) {
                throw refused("These changed since they were read, so nothing was applied: " + drifted.join(", ") + ".");
            }

            try {
                for (i = 0; i < edits.length; i += 1) {
                    touched.push({ property: resolved[i], keys: readKeys(resolved[i]) });
                    writeKeys(resolved[i], edits[i].keys);
                }
            } catch (e) {
                failure = e;
                for (i = touched.length - 1; i >= 0; i -= 1) {
                    try { writeKeys(touched[i].property, touched[i].keys); } catch (ignored) { restoredAll = false; }
                }
                failure = new Error("Could not apply the change: " + (failure && failure.message ? failure.message : String(failure)));
                failure.mdRolledBack = restoredAll;
                throw failure;
            }
            return { applied: edits.length };
        },

        // One frame as a PNG at a stated resolution. The viewer's own
        // resolution is restored afterwards. Returns the size it asked for, so
        // the server can check the file it gets is that size.
        save_frame: function (args) {
            var comp = compById(args.compId);
            var factor = Math.max(1, Math.min(8, Math.round(Number(args.factor) || 1)));
            var previous = comp.resolutionFactor;
            try {
                comp.resolutionFactor = [factor, factor];
                comp.saveFrameToPng(Number(args.time), new File(String(args.path)));
            } finally {
                comp.resolutionFactor = previous;
            }
            return { path: String(args.path), width: Math.ceil(comp.width / factor), height: Math.ceil(comp.height / factor), factor: factor };
        }
    };
}());
