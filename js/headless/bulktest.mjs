import { compat_flags_for_ruleset } from '../defs.js';
import { Level } from '../game.js';
import * as format_c2g from '../format-c2g.js';
import * as format_dat from '../format-dat.js';
import * as format_tws from '../format-tws.js';
import * as util from '../util.js';

import { argv, exit, stderr, stdout } from 'process';
import { opendir, readFile, stat } from 'fs/promises';
import { performance } from 'perf_hooks';

// TODO arguments:
// - custom pack to test, possibly its solutions, possibly its ruleset (or default to steam-strict/lynx)
// - filter existing packs
// - verbose: ?
// - quiet: hide failure reasons
// - support for xfails somehow?
// TODO use this for a test suite

export class LocalDirectorySource extends util.FileSource {
    constructor(root) {
        super();
        this.root = root;
        this.files = {};
        this._loaded_promise = this._scan_dir('/');
    }

    async _scan_dir(path) {
        let dir = await opendir(this.root + path);
        for await (let dirent of dir) {
            if (dirent.isDirectory()) {
                await this._scan_dir(path + dirent.name + '/');
            }
            else {
                let filepath = path + dirent.name;
                this.files[filepath.toLowerCase()] = filepath;
                if (this.files.size > 2000)
                    throw `way, way too many files in local directory source ${this.root}`;
            }
        }
    }

    async get(path) {
        let realpath = this.files[path.toLowerCase()];
        if (realpath) {
            return (await readFile(this.root + realpath)).buffer;
        }
        else {
            throw new Error(`No such file: ${path}`);
        }
    }
}

function pad(s, n) {
    return s.substring(0, n).padEnd(n, " ");
}

const RESULT_TYPES = {
    skipped: {
        color: "\x1b[90m",
        symbol: "-",
    },
    'no-replay': {
        color: "\x1b[90m",
        symbol: "0",
    },
    success: {
        color: "\x1b[92m",
        symbol: ".",
    },
    early: {
        color: "\x1b[96m",
        symbol: "?",
    },
    failure: {
        color: "\x1b[91m",
        symbol: "#",
    },
    'short': {
        color: "\x1b[93m",
        symbol: "#",
    },
    error: {
        color: "\x1b[95m",
        symbol: "X",
    },
};
const ANSI_RESET = "\x1b[39m";

async function test_pack(pack, ruleset, level_filter = null) {
    let dummy_sfx = {
        set_player_position() {},
        play() {},
        play_once() {},
    };
    let compat = compat_flags_for_ruleset(ruleset);

    // TODO factor out the common parts maybe?
    stdout.write(pad(`${pack.title} (${ruleset})`, 20) + " ");
    let num_levels = pack.level_metadata.length;
    let num_passed = 0;
    let num_missing = 0;
    let total_tics = 0;
    let t0 = performance.now();
    let last_pause = t0;
    let failures = [];
    for (let i = 0; i < num_levels; i++) {
        let stored_level, level;
        let level_start_time = performance.now();
        let record_result = (token, short_status, include_canvas, comment) => {
            let result_stuff = RESULT_TYPES[token];
            stdout.write(result_stuff.color + result_stuff.symbol);
            if (token === 'failure' || token === 'short' || token === 'error') {
                failures.push({
                    token,
                    short_status,
                    comment,
                    level,
                    stored_level,
                    index: i,
                    fail_reason: level ? level.fail_reason : null,
                    time_elapsed: performance.now() - level_start_time,
                    time_expected: stored_level ? stored_level.replay.duration / 20 : null,
                    title: stored_level ? stored_level.title : "[error]",
                    time_simulated: level ? level.tic_counter / 20 : null,
                });
            }
            if (level) {
                /*
                    mk('td.-clock', util.format_duration(level.tic_counter / TICS_PER_SECOND)),
                    mk('td.-delta', util.format_duration((level.tic_counter - stored_level.replay.duration) / TICS_PER_SECOND, 2)),
                    mk('td.-speed', ((level.tic_counter / TICS_PER_SECOND) / (performance.now() - level_start_time) * 1000).toFixed(2) + '×'),
                */
            }
            else {
            }

            // FIXME allegedly it's possible to get a canvas working in node...
            /*
            if (include_canvas && level) {
                try {
                    let tileset = this.conductor.choose_tileset_for_level(level.stored_level);
                    this.renderer.set_tileset(tileset);
                    let canvas = mk('canvas', {
                        width: Math.min(this.renderer.canvas.width, level.size_x * tileset.size_x),
                        height: Math.min(this.renderer.canvas.height, level.size_y * tileset.size_y),
                    });
                    this.renderer.set_level(level);
                    this.renderer.set_active_player(level.player);
                    this.renderer.draw();
                    canvas.getContext('2d').drawImage(
                        this.renderer.canvas, 0, 0,
                        this.renderer.canvas.width, this.renderer.canvas.height);
                    tbody.append(mk('tr', mk('td.-full', {colspan: 5}, canvas)));
                }
                catch (e) {
                    console.error(e);
                    tbody.append(mk('tr', mk('td.-full', {colspan: 5},
                        `Internal error while trying to capture screenshot: ${e}`)));
                }
            }
            */

            if (level) {
                total_tics += level.tic_counter;
            }
        };

        if (level_filter && ! level_filter.has(i + 1)) {
            record_result('skipped', "Skipped");
            continue;
        }

        try {
            stored_level = pack.load_level(i);
            if (! stored_level.has_replay) {
                record_result('no-replay', "No replay");
                num_missing += 1;
                continue;
            }

            // TODO? this.current_status.textContent = `Testing level ${i + 1}/${num_levels} ${stored_level.title}...`;

            let replay = stored_level.replay;
            level = new Level(stored_level, compat);
            level.sfx = dummy_sfx;
            level.undo_enabled = false; // slight performance boost
            replay.configure_level(level);

            while (true) {
                let input = replay.get(level.tic_counter);
                level.advance_tic(input);

                if (level.state === 'success') {
                    if (level.tic_counter < replay.duration - 10) {
                        // Early exit is dubious (e.g. this happened sometimes before multiple
                        // players were implemented correctly)
                        record_result('early', "Won early", true);
                    }
                    else {
                        record_result('success', "Won");
                    }
                    num_passed += 1;
                    break;
                }
                else if (level.state === 'failure') {
                    record_result('failure', "Lost", true);
                    break;
                }
                else if (level.tic_counter >= replay.duration + 220) {
                    // This threshold of 11 seconds was scientifically calculated by noticing that
                    // the TWS of Southpole runs 11 seconds past its last input
                    record_result('short', "Out of input", true);
                    break;
                }

                if (level.tic_counter % 20 === 1) {
                    // XXX
                    /*
                    if (handle.cancel) {
                        record_result('interrupted', "Interrupted");
                        this.current_status.textContent = `Interrupted on level ${i + 1}/${num_levels}; ${num_passed} passed`;
                        return;
                    }
                    */

                    // Don't run for more than 100ms at a time, to avoid janking the browser...
                    // TOO much.  I mean, we still want it to reflow the stuff we've added, but
                    // we also want to be pretty aggressive so this finishes quickly
                    // XXX unnecessary headless
                    /*
                    let now = performance.now();
                    if (now - last_pause > 100) {
                        await util.sleep(4);
                        last_pause = now;
                    }
                    */
                }
            }
        }
        catch (e) {
            console.error(e);
            // FIXME this does not seem to work
            record_result(
                'error', "Error", true,
                `Replay failed due to internal error (see console for traceback): ${e}`);
        }
    }

    let total_real_elapsed = (performance.now() - t0) / 1000;

    stdout.write(`${ANSI_RESET} ${num_passed}/${num_levels - num_missing}\n`);
    for (let failure of failures) {
        let short_status = failure.short_status;
        if (failure.token === 'failure') {
            short_status += ": ";
            short_status += failure.fail_reason;
        }

        let parts = [
            String(failure.index + 1).padStart(5),
            pad(failure.title.replace(/[\r\n]+/, " "), 32),
            RESULT_TYPES[failure.token].color + pad(short_status, 20) + ANSI_RESET,
        ];
        if (failure.time_simulated !== null) {
            parts.push("ran for" + util.format_duration(failure.time_simulated).padStart(6, " "));
        }
        if (failure.token === 'failure') {
            parts.push("  with" + util.format_duration(failure.time_expected - failure.time_simulated).padStart(6, " ") + " still to go");
        }
        stdout.write(parts.join(" ") + "\n");
    }

    return {
        num_passed,
        num_missing,
        num_failed: num_levels - num_passed - num_missing,
        time_elapsed: total_real_elapsed,
        time_simulated: total_tics / 20,
    };
}

async function _scan_source(source) {
    // FIXME copied wholesale from Splash.search_multi_source; need a real filesystem + searching api!

    // TODO not entiiirely kosher, but not sure if we should have an api for this or what
    if (source._loaded_promise) {
        await source._loaded_promise;
    }

    let paths = Object.keys(source.files);
    // TODO should handle having multiple candidates, but this is good enough for now
    paths.sort((a, b) => a.length - b.length);
    for (let path of paths) {
        let m = path.match(/[.]([^./]+)$/);
        if (! m)
            continue;

        let ext = m[1];
        // TODO this can't load an individual c2m, hmmm
        if (ext === 'c2g') {
            let buf = await source.get(path);
            //await this.conductor.parse_and_load_game(buf, source, path);
            // FIXME and this is from parse_and_load_game!!
            let dir;
            if (! path.match(/[/]/)) {
                dir = '';
            }
            else {
                dir = path.replace(/[/][^/]+$/, '');
            }
            return await format_c2g.parse_game(buf, source, dir);
        }
    }
    // TODO else...?  complain we couldn't find anything?  list what we did find??  idk
}

// -------------------------------------------------------------------------------------------------

const USAGE = `\
Usage: bulktest.mjs [OPTION]... [FILE]...
Runs replays for the given level packs and report results.
With no FILE given, default to the built-in copy of CC2LP1.

Arguments may be repeated, and apply to any subsequent pack, so different packs
may be run with different compat modes.
  -c            compatibility mode; one of
                  lexy (default), steam, steam-strict, lynx, ms
  -r            path to a file containing replays; for CCL/DAT packs, which
                  don't support built-in replays, this must be a TWS file
  -l            level range to play back; either 'all' or a string like '1-4,10'
  -f            force the next argument to be interpreted as a file path, if for
                    some perverse reason you have a level file named '-c'
  -h, --help    ignore other arguments and show this message

Supports the same filetypes as Lexy's Labyrinth: DAT/CCL, C2M, or a directory
containing a C2G.
`;
class ArgParseError extends Error {}
function parse_level_range(string) {
    if (string === 'all') {
        return null;
    }

    let res = new Set;
    let parts = string.split(/,/);
    for (let part of parts) {
        let endpoints = part.match(/^(\d+)(?:-(\d+))?$/);
        if (endpoints === null)
            throw new ArgParseError(`Bad syntax in level range: ${part}`);
        let a = parseInt(endpoints[1], 10);
        let b = endpoints[2] === undefined ? a : parseInt(endpoints[2], 10);
        if (a > b)
            throw new ArgParseError(`Backwards span in level range: ${part}`);
        for (let n = a; n <= b; n++) {
            res.add(n);
        }
    }

    return res;
}
function parse_args() {
    // Parse arguments
    let test_template = {
        ruleset: 'lexy',
        solutions_path: null,
        level_filter: null,
    };
    let tests = [];

    try {
        let i;
        let next_arg = () => {
            i += 1;
            if (i >= argv.length)
                throw new ArgParseError(`Missing argument after ${argv[i - 1]}`);
            return argv[i];
        };
        for (i = 2; i < argv.length; i++) {
            let arg = argv[i];
            if (arg === '-h' || arg === '--help') {
                stdout.write(USAGE);
                exit(0);
            }

            if (arg === '-c') {
                let ruleset = next_arg();
                if (['lexy', 'steam', 'steam-strict', 'lynx', 'ms'].indexOf(ruleset) === -1)
                    throw new ArgParseError(`Unrecognized compat mode: ${ruleset}`);
                test_template.ruleset = ruleset;
            }
            else if (arg === '-r') {
                test_template.solutions_path = next_arg();
            }
            else if (arg === '-l') {
                test_template.level_filter = parse_level_range(next_arg());
            }
            else if (arg === '-f') {
                tests.push({ pack_path: next_arg(), ...test_template });
            }
            else {
                tests.push({ pack_path: arg, ...test_template });
            }
        }
    }
    catch (e) {
        if (e instanceof ArgParseError) {
            stderr.write(e.message);
            stderr.write("\n");
            exit(2);
        }
    }

    if (tests.length === 0) {
        tests.push({ pack_path: 'levels/CC2LP1.zip', ...test_template });
    }

    return tests;
}

async function main() {
    let tests = parse_args();

    let overall = {
        num_passed: 0,
        num_missing: 0,
        num_failed: 0,
        time_elapsed: 0,
        time_simulated: 0,
    };
    for (let testdef of tests) {
        let pack;
        if ((await stat(testdef.pack_path)).isDirectory()) {
            let source = new LocalDirectorySource(testdef.pack_path);
            pack = await _scan_source(source);
        }
        else {
            let pack_data = await readFile(testdef.pack_path);
            if (testdef.pack_path.match(/[.]zip$/)) {
                let source = new util.ZipFileSource(pack_data.buffer);
                pack = await _scan_source(source);
            }
            else {
                pack = format_dat.parse_game(pack_data.buffer);

                let solutions_data = await readFile(testdef.solutions_path);
                let solutions = format_tws.parse_solutions(solutions_data.buffer);
                pack.level_replays = solutions.levels;
            }
        }

        if (! pack.title) {
            let match = testdef.pack_path.match(/(?:^|\/)([^/.]+)(?:\..*)?\/?$/);
            if (match) {
                pack.title = match[1];
            }
            else {
                pack.title = testdef.pack_path;
            }
        }

        let result = await test_pack(pack, testdef.ruleset, testdef.level_filter);
        for (let key of Object.keys(overall)) {
            overall[key] += result[key];
        }
    }

    let num_levels = overall.num_passed + overall.num_failed + overall.num_missing;
    stdout.write("\n");
    stdout.write(`${overall.num_passed}/${num_levels} = ${(overall.num_passed / num_levels * 100).toFixed(1)}% passed (${overall.num_failed} failed, ${overall.num_missing} missing replay)\n`);
    stdout.write(`Simulated ${util.format_duration(overall.time_simulated)} of game time in ${util.format_duration(overall.time_elapsed)}, speed of ${(overall.time_simulated / overall.time_elapsed).toFixed(1)}×\n`);

}
main();
