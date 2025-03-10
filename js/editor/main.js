import * as fflate from '../vendor/fflate.js';

import { DIRECTIONS, LAYERS } from '../defs.js';
import * as format_base from '../format-base.js';
import * as c2g from '../format-c2g.js';
import * as dat from '../format-dat.js';
import { PrimaryView, MenuOverlay, load_json_from_storage, save_json_to_storage } from '../main-base.js';
import CanvasRenderer from '../renderer-canvas.js';
import TILE_TYPES from '../tiletypes.js';
import { mk, mk_svg, string_from_buffer_ascii, bytestring_to_buffer } from '../util.js';
import * as util from '../util.js';

import * as dialogs from './dialogs.js';
import { TOOLS, TOOL_ORDER, TOOL_SHORTCUTS, PALETTE, SPECIAL_PALETTE_ENTRIES, SPECIAL_TILE_BEHAVIOR, TILE_DESCRIPTIONS, transform_direction_bitmask } from './editordefs.js';
import { SVGConnection, Selection } from './helpers.js';
import * as mouseops from './mouseops.js';
import { TILES_WITH_PROPS } from './tile-overlays.js';


// Edited levels are stored as follows.
// StoredPack and StoredLevel both have an editor_metadata containing:
//   key
// StoredPack's level_metadata contains:
//   stored_level (optional)
//   title
//   key
//   number
//   index
// The editor's own storage contains:
//   packs:
//     key:
//       title
//       level_count
//       last_modified
//       current_level
// And a pack's storage contains:
//   levels:
//     - key
//       title
//       last_modified
const ZOOM_LEVELS = [0.0625, 0.125, 0.25, 0.5, 1, 2, 3, 4, 6, 8, 10, 12, 16];
export class Editor extends PrimaryView {
    constructor(conductor) {
        super(conductor, document.body.querySelector('main#editor'));

        // FIXME possibly rename these lol, adding that scroll container made "viewport" a bit
        // inappropriate
        this.actual_viewport_el = this.root.querySelector('.editor-canvas');
        this.viewport_el = this.root.querySelector('.editor-canvas .-container');

        // Load editor state; we may need this before setup() since we create new levels before
        // actually loading the editor proper
        this.stash = load_json_from_storage("Lexy's Labyrinth editor");
        if (! this.stash) {
            this.stash = {
                packs: {},  // key: { title, level_count, last_modified, current_level }
                // More pack data is stored separately under the key, as {
                //   levels: [{key, title}],
                // }
                // Levels are also stored under separate keys, encoded as C2M.
            };
        }
        this.pack_stash = null;
        this.level_stash = null;

        // FIXME don't hardcode size here, convey this to renderer some other way
        this.renderer = new CanvasRenderer(this.conductor.tilesets['ll'], 32);
        this.renderer.perception = 'editor';
        this.renderer.show_facing = true;

        // FIXME need this in load_level which is called even if we haven't been setup yet
        this.connections_g = mk_svg('g');
        // This SVG draws vectors on top of the editor, like monster paths and button connections
        this.svg_overlay = mk_svg('svg.level-editor-overlay', {viewBox: '0 0 32 32'},
            mk_svg('defs',
                mk_svg('marker', {id: 'overlay-arrowhead', markerWidth: 4, markerHeight: 4, refX: 3, refY: 2, orient: 'auto'},
                    mk_svg('polygon', {points: '0 0, 4 2, 0 4'}),
                ),
            ),
            mk_svg('filter', {id: 'overlay-filter-outline'},
                mk_svg('feMorphology', {'in': 'SourceAlpha', result: 'dilated', operator: 'dilate', radius: 0.03125}),
                mk_svg('feFlood', {'flood-color': '#0009', result: 'fill'}),
                mk_svg('feComposite', {'in': 'fill', in2: 'dilated', operator: 'in'}),
                mk_svg('feComposite', {'in': 'SourceGraphic'}),
            ),
            this.connections_g,
        );
        this.viewport_el.append(this.renderer.canvas, this.svg_overlay);

        // This is done more correctly in setup(), but we need a sensible default so levels can be
        // created before switching to the editor
        this.bg_tile = {type: TILE_TYPES.floor};

        this.level_changed_while_inactive = false;
    }

    setup() {
        // Add more bits to SVG overlay
        this.preview_g = mk_svg('g', {opacity: 0.5});
        this.svg_cursor = mk_svg('rect.overlay-transient.overlay-cursor', {x: 0, y: 0, width: 1, height: 1});
        this.svg_overlay.append(this.preview_g, this.svg_cursor);

        // Populate status bar (needs doing before the mouse stuff, which tries to update it)
        let statusbar = this.root.querySelector('#editor-statusbar');
        this.statusbar_zoom = mk('output');
        this.statusbar_zoom_input = mk('input', {type: 'range', min: 0, max: ZOOM_LEVELS.length - 1});
        this.statusbar_zoom_input.addEventListener('input', ev => {
            let index = parseInt(ev.target.value, 10);
            if (index < 0) {
                index = 0;
            }
            else if (index >= ZOOM_LEVELS.length) {
                index = ZOOM_LEVELS.length - 1;
            }
            // Center the zoom on the center of the viewport
            let rect = this.actual_viewport_el.getBoundingClientRect();
            this.set_canvas_zoom(
                ZOOM_LEVELS[index],
                (rect.left + rect.right) / 2,
                (rect.top + rect.bottom) / 2);
        });
        this.statusbar_cursor = mk('div.-mouse', "—");
        statusbar.append(
            mk('div.-zoom',
                mk_svg('svg.svg-icon', {viewBox: '0 0 16 16'},
                    mk_svg('use', {href: `#svg-icon-zoom`})),
                this.statusbar_zoom_input,
                this.statusbar_zoom,
            ),
            this.statusbar_cursor,
        );

        // Keyboard shortcuts
        window.addEventListener('keydown', ev => {
            if (! this.active)
                return;

            if (ev.ctrlKey) {
                if (ev.key === 'a') {
                    // Select all
                    if (TOOLS[this.current_tool].affects_selection) {
                        // If we're in the middle of using a selection tool, cancel it
                        this.cancel_mouse_drag();
                    }
                    let new_rect = new DOMRect(0, 0, this.stored_level.size_x, this.stored_level.size_y);
                    let old_rect = this.selection.rect;
                    if (! (old_rect && old_rect.x === new_rect.x && old_rect.y === new_rect.y && old_rect.width === new_rect.width && old_rect.height === new_rect.height)) {
                        this.selection.set_from_rect(new_rect);
                        this.commit_undo();
                    }
                }
                else if (ev.key === 'A') {
                    // Deselect
                    if (TOOLS[this.current_tool].affects_selection) {
                        // If we're in the middle of using a selection tool, cancel it
                        this.cancel_mouse_drag();
                    }
                    if (! this.selection.is_empty) {
                        this.selection.defloat();
                        this.selection.clear();
                        this.commit_undo();
                    }
                }
                else if (ev.key === 'z') {
                    this.undo();
                }
                else if (ev.key === 'Z' || ev.key === 'y') {
                    this.redo();
                }
                else {
                    return;
                }
            }
            else {
                if (ev.key === 'Escape') {
                    if (this.mouse_op && this.mouse_op.is_held) {
                        this.mouse_op.do_abort();
                    }
                }
                else if (ev.key === ',') {
                    if (ev.shiftKey) {
                        this.rotate_palette_left();
                    }
                    else if (this.fg_tile) {
                        this.rotate_tile_left(this.fg_tile);
                        this.redraw_foreground_tile();
                    }
                }
                else if (ev.key === '.') {
                    if (ev.shiftKey) {
                        this.rotate_palette_right();
                    }
                    else if (this.fg_tile) {
                        this.rotate_tile_right(this.fg_tile);
                        this.redraw_foreground_tile();
                    }
                }
                else if (TOOL_SHORTCUTS[ev.key]) {
                    this.select_tool(TOOL_SHORTCUTS[ev.key]);
                }
                else {
                    return;
                }
            }

            // If we got here, we did something with the key
            ev.stopPropagation();
            ev.preventDefault();
        });

        // Level canvas and mouse handling
        this.mouse_coords = null;
        this.mouse_op = null;
        this.viewport_el.addEventListener('mousedown', ev => {
            this.mouse_coords = [ev.clientX, ev.clientY];
            this.cancel_mouse_drag();

            let button = ev.button;
            // Macs also use ctrl-left-click to emulate right-click, even though everyone has a
            // two-button mouse, and that messes with us since we want to use ctrl as a modifier.
            // Defeat it by manually checking for the right button bit in ev.buttons
            if (button === 2 && (ev.buttons & 2) === 0) {
                button = 0;
            }

            let op_type = null;
            if (button === 0) {
                // Left button: activate tool
                op_type = TOOLS[this.current_tool].op1;
            }
            else if (button === 1) {
                // Middle button: always pan
                op_type = mouseops.PanOperation;
                // TODO how should this impact the hover?
            }
            else if (button === 2) {
                // Right button: activate tool's alt mode
                op_type = TOOLS[this.current_tool].op2;
            }

            if (! op_type)
                return;

            if (this.mouse_op && this.mouse_op instanceof op_type &&
                this.mouse_op.physical_button === button)
            {
                // Don't replace with the same operation!
            }
            else {
                if (this.mouse_op) {
                    this.mouse_op.do_destroy();
                }
                this.mouse_op = new op_type(this, ev.clientX, ev.clientY, ev.button, button);
            }
            this.mouse_op.do_press(ev);

            ev.preventDefault();
            ev.stopPropagation();
        });
        window.addEventListener('mousemove', ev => {
            if (! this.active)
                return;

            this.mouse_coords = [ev.clientX, ev.clientY];
            // TODO move this into MouseOperation
            let [x, y] = this.renderer.cell_coords_from_event(ev);
            // TODO only do this stuff if the cell coords changed
            let cell = this.cell(x, y);
            if (cell) {
                this.svg_cursor.classList.add('--visible');
                this.svg_cursor.setAttribute('x', x);
                this.svg_cursor.setAttribute('y', y);

                this.statusbar_cursor.textContent = `(${x}, ${y})`;

                // TODO don't /always/ do this.  maybe make it optionally always visible, and have
                // an inspection tool that does it on point
                let terrain = cell[LAYERS.terrain];
                if (terrain.type.name === 'button_gray') {
                }
            }
            else {
                this.svg_cursor.classList.remove('--visible');
                this.statusbar_cursor.textContent = `—`;
            }

            if (! this.mouse_op)
                return;
            this.mouse_op.do_move(ev);
        });
        this.actual_viewport_el.addEventListener('mouseleave', () => {
            if (this.mouse_op) {
                this.mouse_op.do_leave();
            }
        })
        // TODO should this happen for a mouseup anywhere?
        this.viewport_el.addEventListener('mouseup', ev => {
            if (! this.mouse_op)
                return;

            ev.stopPropagation();
            ev.preventDefault();

            this.mouse_op.do_commit();
            // If this was an op for a different button, switch back to the primary
            if (this.mouse_op.physical_button !== 0) {
                this.init_default_mouse_op();
            }
        });
        // Disable context menu, which interferes with right-click tools
        this.viewport_el.addEventListener('contextmenu', ev => {
            ev.preventDefault();
        });
        window.addEventListener('blur', () => {
            this.cancel_mouse_drag();
        });
        window.addEventListener('mouseleave', () => {
            this.mouse_coords = null;
        });
        // Mouse wheel to zoom
        this.set_canvas_zoom(1);
        this.viewport_el.addEventListener('wheel', ev => {
            // The delta is platform and hardware dependent and ultimately kind of useless, so just
            // treat each event as a click and hope for the best
            if (ev.deltaY === 0)
                return;
            ev.stopPropagation();
            ev.preventDefault();

            let index = ZOOM_LEVELS.findIndex(el => el >= this.zoom);
            if (index < 0) {
                index = ZOOM_LEVELS.length - 1;
            }

            let new_zoom;
            if (ev.deltaY > 0) {
                // Zoom out
                if (ZOOM_LEVELS[index] !== this.zoom) {
                    // If we're between levels, pretend we're one level in
                    index += 1;
                }
                if (index <= 0)
                    return;
                new_zoom = ZOOM_LEVELS[index - 1];
            }
            else {
                // Zoom in
                if (ZOOM_LEVELS[index] !== this.zoom) {
                    index -= 1;
                }
                if (index >= ZOOM_LEVELS.length - 1)
                    return;
                new_zoom = ZOOM_LEVELS[index + 1];
            }
            // FIXME preserve the panning such that the point under the cursor doesn't move
            // (possibly difficult given that i can't pan at all if there are no scrollbars??)
            // FIXME add a widget to status bar
            this.set_canvas_zoom(new_zoom, ev.clientX, ev.clientY);
        });

        // Toolbox
        // Selected tile and rotation buttons
        this.fg_tile_el = this.renderer.draw_single_tile_type('wall');
        this.fg_tile_el.id = 'editor-tile';
        this.fg_tile_el.addEventListener('click', () => {
            if (this.fg_tile && TILES_WITH_PROPS[this.fg_tile.type.name]) {
                this.open_tile_prop_overlay(
                    this.fg_tile, null, this.fg_tile_el.getBoundingClientRect());
            }
        });
        this.bg_tile_el = this.renderer.draw_single_tile_type('floor');
        this.bg_tile_el.addEventListener('click', () => {
            if (this.bg_tile && TILES_WITH_PROPS[this.bg_tile.type.name]) {
                this.open_tile_prop_overlay(
                    this.bg_tile, null, this.bg_tile_el.getBoundingClientRect());
            }
        });
        // TODO ones for the palette too??
        this.palette_rotation_index = 0;
        this.palette_actor_direction = 'south';
        let rotate_right_button = mk('button.--image', {type: 'button'}, mk('img', {src: 'icons/rotate-right.png'}));
        rotate_right_button.addEventListener('click', () => {
            this.rotate_tile_right(this.fg_tile);
            this.redraw_foreground_tile();
        });
        let rotate_left_button = mk('button.--image', {type: 'button'}, mk('img', {src: 'icons/rotate-left.png'}));
        rotate_left_button.addEventListener('click', () => {
            this.rotate_tile_left(this.fg_tile);
            this.redraw_foreground_tile();
        });
        this.root.querySelector('.controls').append(
            mk('div.editor-tile-controls',
                rotate_right_button, this.fg_tile_el, rotate_left_button,
                this.bg_tile_el));
        // Tools themselves
        let toolbox = mk('div.icon-button-set', {id: 'editor-toolbar'});
        this.root.querySelector('.controls').append(toolbox);
        this.tool_button_els = {};
        for (let toolname of TOOL_ORDER) {
            let tooldef = TOOLS[toolname];
            let header_text = tooldef.name;
            if (tooldef.shortcut) {
                let shortcut;
                if (tooldef.shortcut === tooldef.shortcut.toUpperCase()) {
                    shortcut = `Shift-${tooldef.shortcut}`;
                }
                else {
                    shortcut = tooldef.shortcut.toUpperCase();
                }
                header_text += ` (${shortcut})`;
            }
            let button = mk(
                'button', {
                    type: 'button',
                    'data-tool': toolname,
                },
                mk('img', {
                    src: tooldef.icon,
                    alt: tooldef.name,
                }),
                mk('div.-help.editor-big-tooltip', mk('h3', header_text), tooldef.desc),
            );
            this.tool_button_els[toolname] = button;
            toolbox.append(button);
        }
        this.current_tool = null;
        this.select_tool('pencil');
        toolbox.addEventListener('click', ev => {
            let button = ev.target.closest('.icon-button-set button');
            if (! button)
                return;

            this.select_tool(button.getAttribute('data-tool'));
        });

        // Toolbar buttons for saving, exporting, etc.
        let button_container = mk('div.-buttons');
        this.root.querySelector('.controls').append(button_container);
        let _make_button = (label, onclick) => {
            let button = mk('button', {type: 'button'}, label);
            button.addEventListener('click', onclick);
            button_container.append(button);
            return button;
        };
        this.undo_button = _make_button("Undo", () => {
            this.undo();
        });
        this.redo_button = _make_button("Redo", () => {
            this.redo();
        });
        let edit_items = [
            ["Rotate CCW", () => {
                this.rotate_level_left();
            }],
            ["Rotate CW", () => {
                this.rotate_level_right();
            }],
            ["Mirror", () => {
                this.mirror_level();
            }],
            ["Flip", () => {
                this.flip_level();
            }],
        ];
        this.edit_menu = new MenuOverlay(
            this.conductor,
            edit_items,
            item => item[0],
            item => item[1](),
        );
        let edit_menu_button = _make_button("Edit ", ev => {
            this.edit_menu.open(ev.currentTarget);
        });
        edit_menu_button.append(
            mk_svg('svg.svg-icon', {viewBox: '0 0 16 16'},
                mk_svg('use', {href: `#svg-icon-menu-chevron`})),
        );
        _make_button("Pack properties...", () => {
            new dialogs.EditorPackMetaOverlay(this.conductor, this.conductor.stored_game).open();
        });
        _make_button("Level properties...", () => {
            new dialogs.EditorLevelMetaOverlay(this.conductor, this.stored_level).open();
        });
        this.save_button = _make_button("Save", () => {
            this.save_level();
        });

        let export_items = [
            ["Share this level with a link", () => {
                // FIXME enable this once gliderbot can understand it
                //let data = util.b64encode(fflate.zlibSync(new Uint8Array(c2g.synthesize_level(this.stored_level))));
                let data = util.b64encode(c2g.synthesize_level(this.stored_level));
                let url = new URL(location);
                url.searchParams.delete('level');
                url.searchParams.delete('setpath');
                url.searchParams.append('level', data);
                new dialogs.EditorShareOverlay(this.conductor, url.toString()).open();
            }],
            ["Download level as C2M (new CC2 format)", () => {
                // TODO support getting warnings + errors out of synthesis
                let buf = c2g.synthesize_level(this.stored_level);
                util.trigger_local_download((this.stored_level.title || 'untitled') + '.c2m', new Blob([buf]));
            }],
            ["Download pack as C2G (new CC2 format)", () => {
                let stored_pack = this.conductor.stored_game;

                // This is pretty heckin' best-effort for now; TODO move into format-c2g?
                let lines = [];
                let safe_title = (stored_pack.title || "untitled").replace(/[""]/g, "'").replace(/[\x00-\x1f]+/g, "_");
                lines.push(`game "${safe_title}"`);

                let files = {};
                let count = stored_pack.level_metadata.length;
                let levelnumlen = String(count).length;
                for (let [i, meta] of stored_pack.level_metadata.entries()) {
                    let c2m;
                    if (i === this.conductor.level_index) {
                        // Use the current state of the current level even if it's not been saved
                        c2m = new Uint8Array(c2g.synthesize_level(this.stored_level));
                    }
                    else if (meta.key) {
                        // This is already in localStorage as a c2m
                        c2m = fflate.strToU8(localStorage.getItem(meta.key), true);
                    }
                    else {
                        let stored_level = stored_pack.load_level(i);
                        c2m = new Uint8Array(c2g.synthesize_level(stored_level));
                    }

                    let safe_title = meta.title.replace(/[\x00-\x1f<>:""\/\\|?*]+/g, '_');
                    let dirchunk = i - i % 50;
                    let dirname = (
                        String(dirchunk + 1).padStart(levelnumlen, '0') + '-' +
                        String(Math.min(count, dirchunk + 50)).padStart(levelnumlen, '0'));
                    let filename = `${dirname}/${i + 1} - ${safe_title}.c2m`;
                    files[filename] = c2m;

                    lines.push(`map "${filename}"`);
                }

                // TODO utf8 encode this
                safe_title = safe_title.replace(/[\x00-\x1f<>:""\/\\|?*]+/g, '_');
                lines.push("");
                files[safe_title + '.c2g'] = fflate.strToU8(lines.join("\n"));
                let u8array = fflate.zipSync(files);

                // TODO support getting warnings + errors out of synthesis
                util.trigger_local_download((stored_pack.title || 'untitled') + '.zip', new Blob([u8array]));
            }],
            ["Download level as CCL (old CC1 format)", () => {
                // TODO support getting warnings out of synthesis?
                let buf;
                try {
                    buf = dat.synthesize_level(this.stored_level);
                }
                catch (errs) {
                    if (errs instanceof dat.CCLEncodingErrors) {
                        new dialogs.EditorExportFailedOverlay(this.conductor, errs.errors).open();
                        return;
                    }
                    throw errs;
                }
                util.trigger_local_download((this.stored_level.title || 'untitled') + '.ccl', new Blob([buf]));
            }],
        ];
        this.export_menu = new MenuOverlay(
            this.conductor,
            export_items,
            item => item[0],
            item => item[1](),
        );
        let export_menu_button = _make_button("Export ", ev => {
            this.export_menu.open(ev.currentTarget);
        });
        export_menu_button.append(
            mk_svg('svg.svg-icon', {viewBox: '0 0 16 16'},
                mk_svg('use', {href: `#svg-icon-menu-chevron`})),
        );
        //_make_button("Toggle green objects");

        // Tile palette
        let palette_el = this.root.querySelector('.palette');
        this.palette = {};  // name => element
        for (let sectiondef of PALETTE) {
            let section_el = mk('section');
            palette_el.append(mk('h2', sectiondef.title), section_el);
            for (let key of sectiondef.tiles) {
                let entry;
                if (SPECIAL_PALETTE_ENTRIES[key]) {
                    let tile = SPECIAL_PALETTE_ENTRIES[key];
                    entry = this.renderer.draw_single_tile_type(tile.name, tile);
                }
                else {
                    entry = this.renderer.draw_single_tile_type(key);
                }
                entry.setAttribute('data-palette-key', key);
                entry.classList = 'palette-entry';
                this.palette[key] = entry;
                section_el.append(entry);
            }
        }
        palette_el.addEventListener('mousedown', ev => {
            let entry = ev.target.closest('canvas.palette-entry');
            if (! entry)
                return;

            let fg;
            if (ev.button === 0) {
                fg = true;
            }
            else if (ev.button === 2) {
                fg = false;
            }
            else {
                return;
            }
            ev.preventDefault();
            ev.stopPropagation();

            let key = entry.getAttribute('data-palette-key');
            if (SPECIAL_PALETTE_ENTRIES[key]) {
                // Tile with preconfigured stuff on it
                let tile = Object.assign({}, SPECIAL_PALETTE_ENTRIES[key]);
                tile.type = TILE_TYPES[tile.name];
                delete tile.name;
                if (fg) {
                    this.select_foreground_tile(tile, true);
                }
                else {
                    if (tile.type.layer !== LAYERS.terrain)
                        return;
                    this.select_background_tile(tile, true);
                }
            }
            else {
                // Regular tile name
                if (fg) {
                    this.select_foreground_tile(key, true);
                }
                else {
                    if (TILE_TYPES[key].layer !== LAYERS.terrain)
                        return;
                    this.select_background_tile(key, true);
                }
            }
        });
        // Disable context menu so right-click works
        palette_el.addEventListener('contextmenu', ev => {
            ev.preventDefault();
        });
        // Hover help
        palette_el.addEventListener('mouseover', ev => {
            let entry = ev.target.closest('canvas.palette-entry');
            if (! entry)
                return;

            this.show_palette_tooltip(entry.getAttribute('data-palette-key'));
        });
        palette_el.addEventListener('mouseout', ev => {
            let entry = ev.target.closest('canvas.palette-entry');
            if (! entry)
                return;

            this.hide_palette_tooltip();
        });
        this.palette_tooltip = mk('div.editor-palette-tooltip.editor-big-tooltip', mk('h3'), mk('p'));
        this.root.append(this.palette_tooltip);

        this.fg_tile = null;  // used for most drawing
        this.fg_tile_from_palette = false;
        this.palette_fg_selected_el = null;
        this.select_foreground_tile('wall', true);
        this.bg_tile = null;  // used to populate new/cleared cells
        this.select_background_tile('floor', true);

        this.selection = new Selection(this);

        this.reset_undo();
    }

    activate() {
        super.activate();
        this._schedule_redraw_loop();

        // Do some final heavyweight or DOM-related setup if the level changed while the editor
        // wasn't showing
        if (this.level_changed_while_inactive) {
            this.level_changed_while_inactive = false;

            this.redraw_entire_level();

            // Reset the scroll position; this happens when loading a level, but if a level is
            // loaded before we're initially visible, all the DOM sizes are zero and it breaks
            this.reset_viewport_scroll();
        }
    }

    deactivate() {
        if (this._redraw_handle) {
            window.cancelAnimationFrame(this._redraw_handle);
            this._redraw_handle = null;
        }
        super.deactivate();
    }

    // ------------------------------------------------------------------------------------------------
    // Level creation, management, and saving

    make_blank_cell(x, y) {
        let cell = new format_base.StoredCell;
        cell.x = x;
        cell.y = y;
        cell[LAYERS.terrain] = {...this.bg_tile};
        return cell;
    }

    _make_empty_level(number, size_x, size_y) {
        let stored_level = new format_base.StoredLevel(number);
        stored_level.title = "untitled level";
        stored_level.size_x = size_x;
        stored_level.size_y = size_y;
        stored_level.viewport_size = 10;
        stored_level.blob_behavior = 2;  // extra random
        for (let i = 0; i < size_x * size_y; i++) {
            stored_level.linear_cells.push(this.make_blank_cell(...stored_level.scalar_to_coords(i)));
        }
        stored_level.linear_cells[0][LAYERS.actor] = {type: TILE_TYPES['player'], direction: 'south'};
        return stored_level;
    }

    _save_pack_to_stash(stored_pack) {
        if (! stored_pack.editor_metadata) {
            console.error("Asked to save a stored pack that's not part of the editor", stored_pack);
            return;
        }

        // Reload the stash in case a pack was created in another tab
        // TODO do this with events
        this.stash = load_json_from_storage("Lexy's Labyrinth editor") ?? this.stash;

        let pack_key = stored_pack.editor_metadata.key;
        this.stash.packs[pack_key] = {
            title: stored_pack.title,
            level_count: stored_pack.level_metadata.length,
            last_modified: Date.now(),
        };
        save_json_to_storage("Lexy's Labyrinth editor", this.stash);
    }

    _save_level_to_storage(stored_level) {
        if (! stored_level.editor_metadata) {
            console.error("Asked to save a stored level that's not part of the editor", stored_level);
            return;
        }

        let buf = c2g.synthesize_level(stored_level);
        let stringy_buf = string_from_buffer_ascii(buf);
        window.localStorage.setItem(stored_level.editor_metadata.key, stringy_buf);
    }

    create_scratch_level() {
        let stored_level = this._make_empty_level(1, 32, 32);

        let stored_pack = new format_base.StoredPack(null);
        stored_pack.title = "scratch pack";
        stored_pack.level_metadata.push({
            stored_level: stored_level,
        });
        this.conductor.load_game(stored_pack);

        this.conductor.switch_to_editor();
    }

    create_pack() {
        let pack_key = `LLP-${Date.now()}`;
        let level_key = `LLL-${Date.now()}`;
        let stored_pack = new format_base.StoredPack(pack_key);
        stored_pack.title = "Untitled pack";
        stored_pack.editor_metadata = {
            key: pack_key,
        };

        let stored_level = this._make_empty_level(1, 32, 32);
        stored_level.editor_metadata = {
            key: level_key,
        };
        // FIXME should convert this to the storage-backed version when switching levels, rather
        // than keeping it around?
        stored_pack.level_metadata.push({
            stored_level: stored_level,
            key: level_key,
            title: stored_level.title,
            index: 0,
            number: 1,
        });
        this.conductor.load_game(stored_pack);

        this._save_pack_to_stash(stored_pack);

        save_json_to_storage(pack_key, {
            levels: [{
                key: level_key,
                title: stored_level.title,
                last_modified: Date.now(),
            }],
            current_level_index: 0,
        });

        this._save_level_to_storage(stored_level);

        this.conductor.switch_to_editor();
    }

    load_editor_pack(pack_key) {
        let pack_stash = load_json_from_storage(pack_key);

        let stored_pack = new format_base.StoredPack(pack_key, meta => {
            let buf = bytestring_to_buffer(localStorage.getItem(meta.key));
            let stored_level = c2g.parse_level(buf, meta.number);
            stored_level.editor_metadata = {
                key: meta.key,
            };
            return stored_level;
        });
        // TODO should this also be in the pack's stash...?
        stored_pack.title = this.stash.packs[pack_key].title;
        stored_pack.editor_metadata = {
            key: pack_key,
        };

        for (let [i, leveldata] of pack_stash.levels.entries()) {
            stored_pack.level_metadata.push({
                key: leveldata.key,
                title: leveldata.title,
                index: i,
                number: i + 1,
            });
        }
        this.conductor.load_game(stored_pack, null, pack_stash.current_level_index);

        this.conductor.switch_to_editor();
    }

    // Move, insert, or delete a level.  If dest_index is null, the level will be deleted.  If
    // source is a number, it's an index; otherwise, it's a level, assumed to be newly-created, and
    // will be given a new key and saved to localStorage.  (Passing null and a level will,
    // of course, do nothing.  Passing an out of bounds source index will also do nothing.)
    move_level(source, dest_index) {
        let stored_pack = this.conductor.stored_game;
        if (! stored_pack.editor_metadata) {
            return;
        }

        // Get the level, and pull it out of the list if necessary
        let stored_level, level_metadata, pack_stash_entry, source_index = null;
        let pack_stash = load_json_from_storage(stored_pack.editor_metadata.key);
        if (typeof source === 'number') {
            if (source === dest_index)
                return;

            source_index = source;
            if (source_index < 0 || source_index >= stored_pack.level_metadata.length) {
                console.warn("Asked to move a level with an out-of-bounds source:", source_index);
                return;
            }

            [level_metadata] = stored_pack.level_metadata.splice(source_index, 1);
            [pack_stash_entry] = pack_stash.levels.splice(source_index, 1);

            stored_level = level_metadata.stored_level ?? null;
            if (stored_level === null && source_index === this.conductor.level_index) {
                stored_level = this.conductor.stored_level;
            }
        }
        else {
            // This is a new level
            if (dest_index === null)
                // Nothing to do
                return;

            dest_index = Math.max(0, Math.min(stored_pack.level_metadata.length, dest_index));

            stored_level = source;
            level_metadata = {
                stored_level: stored_level,
                key: `LLL-${Date.now()}`,
                title: stored_level.title,
                index: dest_index,
                number: dest_index + 1,
            };
            pack_stash_entry = {
                key: level_metadata.key,
                title: stored_level.title,
                last_modified: Date.now(),
            };
            stored_level.editor_metadata = {
                key: level_metadata.key,
            };
            this._save_level_to_storage(stored_level);
        }

        if (dest_index === null) {
            // Erase the level from localStorage
            window.localStorage.removeItem(level_metadata.key);
        }
        else {
            // Add the level to the appropriate place
            if (stored_level) {
                stored_level.index = dest_index;
                stored_level.number = dest_index + 1;
            }
            level_metadata.index = dest_index;
            level_metadata.number = dest_index + 1;

            stored_pack.level_metadata.splice(dest_index, 0, level_metadata);
            pack_stash.levels.splice(dest_index, 0, pack_stash_entry);
        }

        // Renumber levels as necessary
        let delta, start_index, end_index;
        if (source_index === null) {
            // A level was inserted, so increment the number of every level after it
            delta = +1;
            start_index = dest_index + 1;
            end_index = stored_pack.level_metadata.length - 1;
        }
        else if (dest_index === null) {
            // A level was deleted, so decrement the number of every level after it
            delta = -1;
            start_index = source_index;
            end_index = stored_pack.level_metadata.length - 1;
        }
        else {
            // A level was moved, so it depends whether it was moved forwards or backwards
            if (source_index < dest_index) {
                delta = -1;
                start_index = source_index;
                end_index = dest_index - 1;
            }
            else {
                delta = +1;
                start_index = dest_index + 1;
                end_index = source_index;
            }
        }
        for (let i = start_index; i <= end_index; i++) {
            let meta = stored_pack.level_metadata[i];
            meta.index += delta;
            meta.number += delta;
            if (meta.stored_level) {
                meta.stored_level.index += delta;
                meta.stored_level.number += delta;
            }
        }

        // Update the conductor's index too so it doesn't get confused
        if (this.conductor.level_index === source_index) {
            // FIXME refuse to delete the current level
            this.conductor.level_index = dest_index;
        }
        else if (
            this.conductor.level_index === dest_index ||
            (start_index <= this.conductor.level_index && this.conductor.level_index <= end_index))
        {
            this.conductor.level_index += delta;
            // Update the current level if it's not stored in the metadata yet
            // FIXME if you delete the level before the current one, this gets decremented twice?
            // can't seem to reproduce
            if (! stored_level) {
                this.conductor.stored_level.index += delta;
                this.conductor.stored_level.number += delta;
            }
        }

        // Update the title and headers, since the level number might have changed
        this.conductor.update_level_title();
        this.conductor.update_nav_buttons();

        // Save the pack stash and editor stash, and we should be done!
        pack_stash.current_level_index = this.conductor.level_index;
        save_json_to_storage(stored_pack.editor_metadata.key, pack_stash);
        this._save_pack_to_stash(stored_pack);

        return stored_level;
    }

    duplicate_level(index) {
        // The most reliable way to clone a level is to reserialize its current state
        // TODO with autosave this shouldn't be necessary, just copy the existing serialization
        let stored_level = c2g.parse_level(c2g.synthesize_level(this.conductor.stored_game.load_level(index)), index + 2);
        return this.move_level(stored_level, index + 1);
    }

    save_level() {
        // TODO need feedback.  or maybe not bc this should be replaced with autosave later
        // TODO also need to update the pack data's last modified time
        let stored_pack = this.conductor.stored_game;
        if (! stored_pack.editor_metadata)
            return;

        this.modified = false;
        this.undo_modification_offset = 0;

        // Update the pack itself
        // TODO maybe should keep this around, but there's a tricky order of operations thing
        // with it
        let pack_key = stored_pack.editor_metadata.key;
        let pack_stash = load_json_from_storage(pack_key);
        pack_stash.title = stored_pack.title;
        pack_stash.last_modified = Date.now();
        pack_stash.levels[this.conductor.level_index].title = this.stored_level.title;
        pack_stash.levels[this.conductor.level_index].last_modified = Date.now();

        // Save everything at once, level first, to minimize chances of an error getting things
        // out of sync
        this._save_level_to_storage(this.stored_level);
        save_json_to_storage(pack_key, pack_stash);
        this._save_pack_to_stash(stored_pack);

        if (this._level_browser) {
            this._level_browser.expire(this.conductor.level_index);
        }
        this._update_ui_after_edit();
    }

    // ------------------------------------------------------------------------------------------------
    // Level loading

    load_game(stored_game) {
        this._level_browser = null;
    }

    load_level(stored_level) {
        // TODO support a game too i guess
        this.stored_level = stored_level;
        this.update_viewport_size();
        this.update_cell_coordinates();
        this.modified = false;
        if (! this.active) {
            this.level_changed_while_inactive = true;
        }

        // Remember current level for an editor level
        if (this.conductor.stored_game.editor_metadata) {
            let pack_key = this.conductor.stored_game.editor_metadata.key;
            let pack_stash = load_json_from_storage(pack_key);
            pack_stash.current_level_index = this.conductor.level_index;
            save_json_to_storage(pack_key, pack_stash);
        }

        // Load connections
        // TODO what if the source tile is not connectable?
        // TODO there's a has_custom_connections flag, is that important here or is it just because
        // i can't test an object as a bool
        this.connections_g.textContent = '';
        this.connections_elements = {};
        for (let [src, dest] of Object.entries(this.stored_level.custom_connections)) {
            let [sx, sy] = this.stored_level.scalar_to_coords(src);
            let [dx, dy] = this.stored_level.scalar_to_coords(dest);
            let el = new SVGConnection(sx, sy, dx, dy).element;
            this.connections_elements[src] = el;
            this.connections_g.append(el);
        }
        // TODO why are these in connections_g lol
        for (let [i, region] of this.stored_level.camera_regions.entries()) {
            let el = mk_svg('rect.overlay-camera', {x: region.x, y: region.y, width: region.width, height: region.height});
            this.connections_g.append(el);
        }

        this.renderer.set_level(stored_level);
        if (this.active) {
            this.redraw_entire_level();
        }
        this.reset_viewport_scroll();

        if (this._done_setup) {
            // XXX this doesn't work yet if setup hasn't run because the undo button won't exist
            this.reset_undo();
        }
    }

    update_cell_coordinates() {
        // We rely on each StoredCell having .x and .y for partial redrawing
        for (let [i, cell] of this.stored_level.linear_cells.entries()) {
            [cell.x, cell.y] = this.stored_level.scalar_to_coords(i);
        }
    }

    update_viewport_size() {
        this.renderer.set_viewport_size(this.stored_level.size_x, this.stored_level.size_y);
        this.svg_overlay.setAttribute('viewBox', `0 0 ${this.stored_level.size_x} ${this.stored_level.size_y}`);
    }

    update_after_size_change() {
        this.update_viewport_size();
        this.update_cell_coordinates();
        this.redraw_entire_level();
    }

    // ------------------------------------------------------------------------------------------------

    set_canvas_zoom(zoom, origin_x = null, origin_y = null) {
        // Adjust scrolling so that the point under the mouse cursor remains fixed
        let scroll_adjust_x = null;
        let scroll_adjust_y = null;
        if (origin_x !== null && this.zoom) {
            // FIXME possible sign of a bad api
            let [frac_cell_x, frac_cell_y] = this.renderer.real_cell_coords_from_event({clientX: origin_x, clientY: origin_y});
            // Zooming is really just resizing a DOM element, which doesn't affect either the
            // transparent border or the scroll position, so zooming from Z1 to Z2 will move a point
            // from X * Z1 to X * Z2.  To keep it at the same client point, the scroll position
            // thus needs to change by X * (Z2 - Z1).
            scroll_adjust_x = frac_cell_x * (zoom - this.zoom) * this.renderer.tileset.size_x;
            scroll_adjust_y = frac_cell_y * (zoom - this.zoom) * this.renderer.tileset.size_y;
        }

        this.zoom = zoom;
        this.renderer.canvas.style.setProperty('--scale', this.zoom);
        this.actual_viewport_el.classList.toggle('--crispy', this.zoom >= 1);
        this.statusbar_zoom.textContent = `${this.zoom * 100}%`;

        let index = ZOOM_LEVELS.findIndex(el => el >= this.zoom);
        if (index < 0) {
            index = ZOOM_LEVELS.length - 1;
        }
        this.statusbar_zoom_input.value = index;

        // Only actually adjust the scroll position after changing the zoom, or it might not be
        // possible to scroll that far yet
        if (scroll_adjust_x !== null) {
            this.actual_viewport_el.scrollLeft += scroll_adjust_x;
            this.actual_viewport_el.scrollTop += scroll_adjust_y;
        }
    }

    reset_viewport_scroll() {
        // Position the level within the viewport; the default is no scroll, which will mostly show
        // empty space.  Try to put a 1-cell margin around it; if it fits, center it; if not, put
        // the top-left corner at the top-left of the viewport.
        let canvas_width = this.renderer.canvas.offsetWidth;
        let canvas_height = this.renderer.canvas.offsetHeight;
        let padded_canvas_width = canvas_width * (1 + 2 / this.stored_level.size_x);
        let padded_canvas_height = canvas_height * (1 + 2 / this.stored_level.size_y);
        let area_width = this.viewport_el.offsetWidth;
        let area_height = this.viewport_el.offsetHeight;
        let viewport_width = this.actual_viewport_el.offsetWidth;
        let viewport_height = this.actual_viewport_el.offsetHeight;
        this.actual_viewport_el.scrollLeft = (area_width - Math.max(viewport_width, padded_canvas_width)) / 2;
        this.actual_viewport_el.scrollTop = (area_height - Math.max(viewport_height, padded_canvas_height)) / 2;
    }

    open_level_browser() {
        if (! this._level_browser) {
            this._level_browser = new dialogs.EditorLevelBrowserOverlay(this.conductor);
        }
        this._level_browser.open();
    }

    select_tool(tool) {
        if (tool === this.current_tool)
            return;
        if (! this.tool_button_els[tool])
            return;

        if (this.current_tool) {
            this.tool_button_els[this.current_tool].classList.remove('-selected');
        }
        this.current_tool = tool;
        this.tool_button_els[this.current_tool].classList.add('-selected');
        this.init_default_mouse_op();
    }

    init_default_mouse_op() {
        if (this.mouse_op) {
            this.mouse_op.do_destroy();
            this.mouse_op = null;
        }
        if (this.current_tool && TOOLS[this.current_tool].op1) {
            this.mouse_op = new TOOLS[this.current_tool].op1(this, ...(this.mouse_coords ?? [0, 0]), 0);  // FIXME?
        }
    }

    show_palette_tooltip(key) {
        let desc = TILE_DESCRIPTIONS[key];
        if (! desc && SPECIAL_PALETTE_ENTRIES[key]) {
            let name = SPECIAL_PALETTE_ENTRIES[key].name;
            desc = TILE_DESCRIPTIONS[name];
        }

        if (! desc) {
            this.palette_tooltip.classList.remove('--visible');
            return;
        }

        this.palette_tooltip.classList.add('--visible');
        this.palette_tooltip.querySelector('h3').textContent = desc.name;
        this.palette_tooltip.querySelector('p').textContent = desc.desc;

        // Place it out of the way of the palette (so, overlaying the level) but roughly vertically
        // aligned
        let palette_rect = this.root.querySelector('.palette').getBoundingClientRect();
        let entry_rect = this.palette[key].getBoundingClientRect();
        let tip_height = this.palette_tooltip.offsetHeight;
        this.palette_tooltip.style.left = `${palette_rect.right}px`;
        this.palette_tooltip.style.top = `${Math.min(entry_rect.top, palette_rect.bottom - tip_height)}px`;
    }

    hide_palette_tooltip() {
        this.palette_tooltip.classList.remove('--visible');
    }

    _name_or_tile_to_name_and_tile(name_or_tile) {
        let name, tile;
        if (typeof name_or_tile === 'string') {
            name = name_or_tile;
            tile = { type: TILE_TYPES[name] };

            if (tile.type.is_actor) {
                tile.direction = 'south';
            }
            if (TILES_WITH_PROPS[name]) {
                TILES_WITH_PROPS[name].configure_tile_defaults(tile);
            }
        }
        else {
            tile = {...name_or_tile};
            name = tile.type.name;
        }
        return [name, tile];
    }

    select_foreground_tile(name_or_tile, from_palette = false) {
        let [name, tile] = this._name_or_tile_to_name_and_tile(name_or_tile);

        // Deselect any previous selection
        if (this.palette_fg_selected_el) {
            this.palette_fg_selected_el.classList.remove('--selected');
        }

        // Store the tile
        this.fg_tile = tile;
        this.fg_tile_from_palette = from_palette;

        // Select it in the palette, if possible
        let key = name;
        let behavior = SPECIAL_TILE_BEHAVIOR[name];
        if (behavior && behavior.pick_palette_entry) {
            key = SPECIAL_TILE_BEHAVIOR[name].pick_palette_entry(tile);
        }
        this.palette_fg_selected_el = this.palette[key] ?? null;
        if (this.palette_fg_selected_el) {
            this.palette_fg_selected_el.classList.add('--selected');
        }

        this.redraw_foreground_tile();

        // Some tools obviously don't work with a palette selection, in which case changing tiles
        // should default you back to the pencil
        if (! TOOLS[this.current_tool].uses_palette) {
            this.select_tool('pencil');
        }
    }

    select_background_tile(name_or_tile) {
        let [_name, tile] = this._name_or_tile_to_name_and_tile(name_or_tile);

        this.bg_tile = tile;

        this.redraw_background_tile();
    }

    // Transform an individual tile in various ways.  No undo handling (as the tile may or may not
    // even be part of the level).
    _transform_tile(tile, adjust_method, transform_method, direction_property) {
        let did_anything = true;

        let behavior = SPECIAL_TILE_BEHAVIOR[tile.type.name];
        if (adjust_method && behavior && behavior[adjust_method]) {
            behavior[adjust_method](tile);
        }
        else if (behavior && behavior[transform_method]) {
            behavior[transform_method](tile);
        }
        else if (TILE_TYPES[tile.type.name].is_actor) {
            tile.direction = DIRECTIONS[tile.direction ?? 'south'][direction_property];
        }
        else {
            did_anything = false;
        }

        if (tile.wire_directions) {
            tile.wire_directions = transform_direction_bitmask(
                tile.wire_directions, direction_property);
            did_anything = true;
        }
        if (tile.wire_tunnel_directions) {
            tile.wire_tunnel_directions = transform_direction_bitmask(
                tile.wire_tunnel_directions, direction_property);
            did_anything = true;
        }

        return did_anything;
    }
    rotate_tile_left(tile, include_faux_adjustments = true) {
        return this._transform_tile(
            tile, include_faux_adjustments ? 'adjust_backward' : null, 'rotate_left', 'left');
    }
    rotate_tile_right(tile, include_faux_adjustments = true) {
        return this._transform_tile(
            tile, include_faux_adjustments ? 'adjust_forward' : null, 'rotate_right', 'right');
    }
    mirror_tile(tile) {
        return this._transform_tile(tile, null, 'mirror', 'mirrored');
    }
    flip_tile(tile) {
        return this._transform_tile(tile, null, 'flip', 'flipped');
    }

    rotate_palette_left() {
        this.palette_rotation_index += 1;
        this.palette_rotation_index %= 4;
        this.palette_actor_direction = DIRECTIONS[this.palette_actor_direction].left;
    }

    // ------------------------------------------------------------------------------------------------
    // Drawing

    redraw_foreground_tile() {
        let ctx = this.fg_tile_el.getContext('2d');
        ctx.clearRect(0, 0, this.fg_tile_el.width, this.fg_tile_el.height);
        this.renderer.draw_single_tile_type(
            this.fg_tile.type.name, this.fg_tile, this.fg_tile_el);
        if (this.mouse_op) {
            this.mouse_op.handle_tile_updated();
        }
    }

    redraw_background_tile() {
        let ctx = this.bg_tile_el.getContext('2d');
        ctx.clearRect(0, 0, this.bg_tile_el.width, this.bg_tile_el.height);
        this.renderer.draw_single_tile_type(
            this.bg_tile.type.name, this.bg_tile, this.bg_tile_el);
        if (this.mouse_op) {
            this.mouse_op.handle_tile_updated(true);
        }
    }

    mark_cell_dirty(cell) {
        this.mark_point_dirty(cell.x, cell.y);
    }

    mark_point_dirty(x, y) {
        if (! this._dirty_rect) {
            this._dirty_rect = new DOMRect(x, y, 1, 1);
        }
        else {
            let rect = this._dirty_rect;
            if (x < rect.left) {
                rect.width = rect.right - x;
                rect.x = x;
            }
            else if (x >= rect.right) {
                rect.width = x - rect.left + 1;
            }
            if (y < rect.top) {
                rect.height = rect.bottom - y;
                rect.y = y;
            }
            else if (y >= rect.bottom) {
                rect.height = y - rect.top + 1;
            }
        }
    }

    redraw_entire_level() {
        this.renderer.draw_static_region(0, 0, this.stored_level.size_x, this.stored_level.size_y);
    }

    _schedule_redraw_loop() {
        this._redraw_handle = window.requestAnimationFrame(this._redraw_dirty.bind(this));
        this._dirty_rect = null;
    }

    // Automatically redraw only what's changed
    _redraw_dirty() {
        // TODO draw sparkle background under the starting player
        if (this._dirty_rect) {
            this.renderer.draw_static_region(
                this._dirty_rect.left, this._dirty_rect.top,
                this._dirty_rect.right, this._dirty_rect.bottom);
        }
        this._schedule_redraw_loop();
    }

    // ------------------------------------------------------------------------------------------------
    // Utility/inspection

    is_in_bounds(x, y) {
        return this.stored_level.is_point_within_bounds(x, y);
    }

    cell(x, y) {
        return this.stored_level.cell(x, y);
    }

    // ------------------------------------------------------------------------------------------------
    // Mutation

    // DOES NOT commit the undo entry!
    place_in_cell(cell, tile) {
        // TODO weird api?
        if (! tile)
            return;

        if (! this.selection.contains(cell.x, cell.y))
            return;

        // Replace whatever's on the same layer
        let layer = tile.type.layer;
        let existing_tile = cell[layer];

        // If we find a tile of the same type as the one being drawn, see if it has custom combine
        // behavior (only the case if it came from the palette)
        if (existing_tile && existing_tile.type === tile.type &&
            // FIXME this is hacky garbage
            tile === this.fg_tile && this.fg_tile_from_palette &&
            SPECIAL_TILE_BEHAVIOR[tile.type.name] &&
            SPECIAL_TILE_BEHAVIOR[tile.type.name].combine_draw)
        {
            let old_tile = {...existing_tile};
            let new_tile = existing_tile;
            SPECIAL_TILE_BEHAVIOR[tile.type.name].combine_draw(tile, new_tile);
            this._assign_tile(cell, layer, new_tile, old_tile);
            return;
        }

        let new_tile = {...tile};
        // Special case: preserve wires when replacing one wired tile with another
        if (new_tile.type.contains_wire &&
            // FIXME this is hacky garbage
            tile === this.fg_tile && this.fg_tile_from_palette && existing_tile !== undefined)
        {
            if (existing_tile.type.contains_wire) {
                new_tile.wire_directions = existing_tile.wire_directions;
            }
            else if (existing_tile.type.name === 'logic_gate') {
                // Extract the wires from logic gates
                new_tile.wire_directions = 0;
                for (let dir of existing_tile.type.get_wires(existing_tile)) {
                    if (dir) {
                        new_tile.wire_directions |= DIRECTIONS[dir].bit;
                    }
                }
            }
        }

        this._assign_tile(cell, layer, new_tile, existing_tile);
    }

    erase_tile(cell, tile = null) {
        // TODO respect selection

        if (tile === null) {
            tile = this.fg_tile;
        }

        let existing_tile = cell[tile.type.layer];

        // If we find a tile of the same type as the one being drawn, see if it has custom combine
        // behavior (only the case if it came from the palette)
        if (existing_tile && existing_tile.type === tile.type &&
            // FIXME this is hacky garbage
            tile === this.fg_tile && this.fg_tile_from_palette &&
            SPECIAL_TILE_BEHAVIOR[tile.type.name] &&
            SPECIAL_TILE_BEHAVIOR[tile.type.name].combine_erase)
        {
            let old_tile = {...existing_tile};
            let new_tile = existing_tile;
            let remove = SPECIAL_TILE_BEHAVIOR[tile.type.name].combine_erase(tile, new_tile);
            if (! remove) {
                this._assign_tile(cell, tile.type.layer, new_tile, old_tile);
                return;
            }
        }

        let new_tile = null;
        if (tile.type.layer === LAYERS.terrain) {
            new_tile = {...this.bg_tile};
        }

        this._assign_tile(cell, tile.type.layer, new_tile, existing_tile);
    }

    replace_cell(cell, new_cell) {
        // Save the coordinates so it doesn't matter what they are when undoing
        let x = cell.x, y = cell.y;
        let n = this.stored_level.coords_to_scalar(x, y);
        this._do(
            () => {
                this.stored_level.linear_cells[n] = new_cell;
                new_cell.x = x;
                new_cell.y = y;
                this.mark_cell_dirty(new_cell);
            },
            () => {
                this.stored_level.linear_cells[n] = cell;
                cell.x = x;
                cell.y = y;
                this.mark_cell_dirty(cell);
            },
        );
    }

    resize_level(size_x, size_y, x0 = 0, y0 = 0) {
        let new_cells = [];
        for (let y = y0; y < y0 + size_y; y++) {
            for (let x = x0; x < x0 + size_x; x++) {
                new_cells.push(this.cell(x, y) ?? this.make_blank_cell(x, y));
            }
        }

        let original_cells = this.stored_level.linear_cells;
        let original_size_x = this.stored_level.size_x;
        let original_size_y = this.stored_level.size_y;

        this._do(() => {
            this.stored_level.linear_cells = new_cells;
            this.stored_level.size_x = size_x;
            this.stored_level.size_y = size_y;
            this.update_after_size_change();
        }, () => {
            this.stored_level.linear_cells = original_cells;
            this.stored_level.size_x = original_size_x;
            this.stored_level.size_y = original_size_y;
            this.update_after_size_change();
        });
        this.commit_undo();
    }

    // Rearranges cells in the current selection or whole level, based on a few callbacks.
    // DOES NOT commit.
    // (These don't save undo entries for individual tiles, either, because they're expected to be
    // completely reversible, and undo is done by performing the opposite transform rather than
    // reloading a copy of a previous state.)
    _rearrange_cells(swap_dimensions, downgrade_coords, upgrade_tile) {
        let old_cells, old_w;
        let w, h;
        let new_cells = [];
        if (this.selection.is_empty) {
            // Do it to the whole level
            w = this.stored_level.size_x;
            h = this.stored_level.size_y;
            old_w = w;
            if (swap_dimensions) {
                [w, h] = [h, w];
                this.stored_level.size_x = w;
                this.stored_level.size_y = h;
            }
            old_cells = this.stored_level.linear_cells;
            this.stored_level.linear_cells = new_cells;
        }
        else {
            // Do it to the selection
            w = this.selection.rect.width;
            h = this.selection.rect.height;
            old_w = w;
            if (swap_dimensions) {
                [w, h] = [h, w];
                this.selection._set_from_rect(new DOMRect(
                    this.selection.rect.x, this.selection.rect.y, w, h));
            }
            old_cells = this.selection.floated_cells;
            this.selection.floated_cells = new_cells;
        }

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let [old_x, old_y] = downgrade_coords(x, y, w, h);
                let cell = old_cells[old_y * old_w + old_x];
                for (let tile of cell) {
                    if (tile) {
                        upgrade_tile(tile);
                    }
                }
                new_cells.push(cell);
            }
        }
    }

    rotate_level_right() {
        this._do_transform(
            true,
            () => this._rotate_level_right(),
            () => this._rotate_level_left(),
        );
    }
    rotate_level_left() {
        this._do_transform(
            true,
            () => this._rotate_level_left(),
            () => this._rotate_level_right(),
        );
    }
    rotate_level_180() {
    }
    mirror_level() {
        this._do_transform(
            false,
            () => this._mirror_level(),
            () => this._mirror_level(),
        );
    }
    flip_level() {
        this._do_transform(
            false,
            () => this._flip_level(),
            () => this._flip_level(),
        );
    }
    _do_transform(affects_size, redo, undo) {
        // FIXME apply transform to connections if appropriate, somehow, ??  i don't even know how
        // those interact with floating selection yet  :S
        if (! this.selection.is_empty && ! this.selection.is_floating) {
            this.selection.enfloat();
        }
        this._do(
            () => {
                redo();
                this._post_transform_cleanup(affects_size);
            },
            () => {
                undo();
                this._post_transform_cleanup(affects_size);
            },
        );
        this.commit_undo();
    }
    _post_transform_cleanup(affects_size) {
        if (this.selection.is_empty) {
            if (affects_size) {
                this.update_after_size_change();
            }
            else {
                this.redraw_entire_level();
            }
        }
        else {
            // FIXME what if it affects size?
            this.selection.redraw();
        }
    }
    // TODO mirror diagonally?

    // Internal-use versions of the above.  These DO NOT create undo entries.
    _rotate_level_left() {
        this._rearrange_cells(
            true,
            (x, y, w, h) => [h - 1 - y, x],
            tile => this.rotate_tile_left(tile, false),
        );
    }
    _rotate_level_right() {
        this._rearrange_cells(
            true,
            (x, y, w, h) => [y, w - 1 - x],
            tile => this.rotate_tile_right(tile, false),
        );
    }
    _mirror_level() {
        this._rearrange_cells(
            false,
            (x, y, w, h) => [w - 1 - x, y],
            tile => this.mirror_tile(tile),
        );
    }
    _flip_level() {
        this._rearrange_cells(
            false,
            (x, y, w, h) => [x, h - 1 - y],
            tile => this.flip_tile(tile),
        );
    }

    // Create a connection between two cells and update the UI accordingly.  If dest is null or
    // undefined, delete any existing connection instead.
    set_custom_connection(src, dest) {
        let prev = this.stored_level.custom_connections[src];
        this._do(
            () => this._set_custom_connection(src, dest),
            () => this._set_custom_connection(src, prev),
        );
    }
    _set_custom_connection(src, dest) {
        if (this.connections_elements[src]) {
            this.connections_elements[src].remove();
        }

        if ((dest ?? null) === null) {
            delete this.stored_level.custom_connections[src];
            delete this.connections_elements[src];
        }
        else {
            this.stored_level.custom_connections[src] = dest;
            let el = new SVGConnection(
                ...this.stored_level.scalar_to_coords(src),
                ...this.stored_level.scalar_to_coords(dest),
            ).element;
            this.connections_elements[src] = el;
            this.connections_g.append(el);
        }
    }

    // ------------------------------------------------------------------------------------------------
    // Undo/redo

    _do(redo, undo, modifies = true) {
        redo();
        this._done(redo, undo, modifies);
    }

    _done(redo, undo, modifies = true) {
        // TODO parallel arrays would be smaller
        this.undo_entry.push([undo, redo]);
        if (modifies) {
            this.undo_entry.modifies = true;
        }
    }

    _assign_tile(cell, layer, new_tile, old_tile) {
        this._do(
            () => {
                cell[layer] = new_tile;
                this.mark_cell_dirty(cell);
            },
            () => {
                cell[layer] = old_tile;
                this.mark_cell_dirty(cell);
            },
        );
    }

    reset_undo() {
        this.undo_entry = [];
        this.undo_stack = [];
        this.redo_stack = [];
        // Number of steps we'd need to take (negative if redo, positive if undo) to reach a
        // pristine saved state.  May also be null, meaning the pristine state is in a redo branch
        // that has been overwritten and is thus unreachable.
        this.undo_modification_offset = 0;
        this._update_ui_after_edit();
    }

    undo() {
        // We shouldn't really have an uncommitted entry lying around at a time when the user can
        // click the undo button, but just in case, prefer that to the undo stack
        let entry;
        if (this.undo_entry.length > 0) {
            entry = this.undo_entry;
            this.undo_entry = [];
            console.warn("lingering undo entry");
        }
        else if (this.undo_stack.length > 0) {
            entry = this.undo_stack.pop();
            this.redo_stack.push(entry);
        }
        else {
            return;
        }

        for (let i = entry.length - 1; i >= 0; i--) {
            entry[i][0]();
        }

        this._track_undo_offset(-1, entry.modifies);

        this._update_ui_after_edit();
    }

    redo() {
        if (this.redo_stack.length === 0)
            return;

        this.commit_undo();
        let entry = this.redo_stack.pop();
        this.undo_stack.push(entry);
        for (let [_undo, redo] of entry) {
            redo();
        }

        this._track_undo_offset(+1, entry.modifies);

        this._update_ui_after_edit();
    }

    _track_undo_offset(delta, modifies) {
        if (this.undo_modification_offset === null) {
            return;
        }
        else if (this.undo_modification_offset === 0) {
            if (modifies) {
                this.modified = true;
                this.undo_modification_offset += delta;
            }
        }
        else {
            this.undo_modification_offset += delta;
            if (this.undo_modification_offset === 0) {
                this.modified = false;
            }
        }
    }

    // TODO give these names/labels?
    commit_undo() {
        if (this.undo_entry.length === 0)
            return;

        if (this.undo_entry.modifies) {
            this.modified = true;
        }
        this.undo_stack.push(this.undo_entry);
        this.undo_entry = [];

        // Doing an action always erases the redo stack
        if (this.redo_stack.length > 0) {
            this.redo_stack.length = 0;
            if (this.undo_modification_offset < 0) {
                // Pristine state was in the future, so it's now unreachable
                this.undo_modification_offset = null;
            }
        }

        this._update_ui_after_edit();
    }

    _update_ui_after_edit() {
        this.undo_button.disabled = this.undo_stack.length === 0;
        this.redo_button.disabled = this.redo_stack.length === 0;
        this.save_button.disabled = ! (
            this.stored_level && this.modified && this.conductor.stored_game.editor_metadata);
    }

    // ------------------------------------------------------------------------------------------------
    // Misc UI stuff

    open_tile_prop_overlay(tile, cell, rect) {
        this.cancel_mouse_drag();
        // FIXME keep these around, don't recreate them constantly
        let overlay_class = TILES_WITH_PROPS[tile.type.name];
        let overlay = new overlay_class(this.conductor);
        overlay.edit_tile(tile, cell);
        overlay.open();

        // Fixed-size balloon positioning
        // FIXME move this into TransientOverlay or some other base class
        let root = overlay.root;
        let spacing = 2;
        // Vertical position: either above or below, preferring the side that has more space
        if (rect.top - 0 > document.body.clientHeight - rect.bottom) {
            // Above
            root.classList.add('--above');
            root.style.top = `${rect.top - root.offsetHeight - spacing}px`;
        }
        else {
            // Below
            root.classList.remove('--above');
            root.style.top = `${rect.bottom + spacing}px`;
        }
        // Horizontal position: centered, but kept within the screen
        let left;
        let margin = 8;  // prefer to not quite touch the edges
        if (document.body.clientWidth < root.offsetWidth + margin * 2) {
            // It doesn't fit on the screen at all, so there's nothing we can do; just center it
            left = (document.body.clientWidth - root.offsetWidth) / 2;
        }
        else {
            left = Math.max(margin, Math.min(document.body.clientWidth - root.offsetWidth - margin,
                (rect.left + rect.right - root.offsetWidth) / 2));
        }
        root.style.left = `${left}px`;
        root.style.setProperty('--chevron-offset', `${(rect.left + rect.right) / 2 - left}px`);
    }

    cancel_mouse_drag() {
        if (this.mouse_op && this.mouse_op.is_held) {
            this.mouse_op.do_abort();
        }
    }
}
