import * as fflate from './vendor/fflate.js';

import { DIRECTIONS, LAYERS, TICS_PER_SECOND } from './defs.js';
import { TILES_WITH_PROPS } from './editor-tile-overlays.js';
import * as format_base from './format-base.js';
import * as c2g from './format-c2g.js';
import * as dat from './format-dat.js';
import { PrimaryView, MenuOverlay, DialogOverlay, AlertOverlay, flash_button, load_json_from_storage, save_json_to_storage } from './main-base.js';
import CanvasRenderer from './renderer-canvas.js';
import TILE_TYPES from './tiletypes.js';
import { SVG_NS, mk, mk_button, mk_svg, string_from_buffer_ascii, bytestring_to_buffer, walk_grid } from './util.js';
import * as util from './util.js';

class EditorPackMetaOverlay extends DialogOverlay {
    constructor(conductor, stored_pack) {
        super(conductor);
        this.set_title("pack properties");
        let dl = mk('dl.formgrid');
        this.main.append(dl);

        dl.append(
            mk('dt', "Title"),
            mk('dd', mk('input', {name: 'title', type: 'text', value: stored_pack.title})),
        );
        // TODO...?  what else is a property of the pack itself

        this.add_button("save", () => {
            let els = this.root.elements;

            let title = els.title.value;
            if (title !== stored_pack.title) {
                stored_pack.title = title;
                this.conductor.update_level_title();
            }

            this.close();
        });
        this.add_button("nevermind", () => {
            this.close();
        });
    }
}

class EditorLevelMetaOverlay extends DialogOverlay {
    constructor(conductor, stored_level) {
        super(conductor);
        this.set_title("level properties");
        let dl = mk('dl.formgrid');
        this.main.append(dl);

        let time_limit_input = mk('input', {name: 'time_limit', type: 'number', min: 0, max: 65535, value: stored_level.time_limit});
        let time_limit_output = mk('output');
        let update_time_limit = () => {
            let time_limit = parseInt(time_limit_input.value, 10);
            // FIXME need a change event for this tbh?
            // FIXME handle NaN; maybe block keydown of not-numbers
            time_limit = Math.max(0, Math.min(65535, time_limit));
            time_limit_input.value = time_limit;

            let text;
            if (time_limit === 0) {
                text = "No time limit";
            }
            else {
                text = util.format_duration(time_limit);
            }
            time_limit_output.textContent = text;
        };
        update_time_limit();
        time_limit_input.addEventListener('input', update_time_limit);

        let make_size_input = (name) => {
            let input = mk('input', {name: name, type: 'number', min: 10, max: 100, value: stored_level[name]});
            // TODO maybe block keydown of non-numbers too?
            // Note that this is a change event, not an input event, so we don't prevent them from
            // erasing the whole value to type a new one
            input.addEventListener('change', ev => {
                let value = parseInt(ev.target.value, 10);
                if (isNaN(value)) {
                    ev.target.value = stored_level[name];
                }
                else if (value < 1) {
                    // Smaller than 10×10 isn't supported by CC2, but LL doesn't mind, so let it
                    // through if they try it manually
                    ev.target.value = 1;
                }
                else if (value > 100) {
                    ev.target.value = 100;
                }
            });
            return input;
        };

        let make_radio_set = (name, options) => {
            let elements = [];
            for (let [label, value] of options) {
                elements.push();
            }
        };

        dl.append(
            mk('dt', "Title"),
            mk('dd.-one-field', mk('input', {name: 'title', type: 'text', value: stored_level.title})),
            mk('dt', "Author"),
            mk('dd.-one-field', mk('input', {name: 'author', type: 'text', value: stored_level.author})),
            mk('dt', "Comment"),
            mk('dd.-textarea', mk('textarea', {name: 'comment', rows: 4, cols: 20}, stored_level.comment)),
            mk('dt', "Time limit"),
            mk('dd.-with-buttons',
                mk('div.-left',
                    time_limit_input,
                    " ",
                    time_limit_output,
                ),
                mk('div.-right',
                    mk_button("None", ev => {
                        this.root.elements['time_limit'].value = 0;
                        update_time_limit();
                    }),
                    mk_button("−30s", ev => {
                        this.root.elements['time_limit'].value = Math.max(0,
                            parseInt(this.root.elements['time_limit'].value, 10) - 30);
                        update_time_limit();
                    }),
                    mk_button("+30s", ev => {
                        this.root.elements['time_limit'].value = Math.min(999,
                            parseInt(this.root.elements['time_limit'].value, 10) + 30);
                        update_time_limit();
                    }),
                    mk_button("Max", ev => {
                        this.root.elements['time_limit'].value = 999;
                        update_time_limit();
                    }),
                ),
            ),
            mk('dt', "Size"),
            mk('dd.-with-buttons',
                mk('div.-left', make_size_input('size_x'), " × ", make_size_input('size_y')),
                mk('div.-right', ...[10, 32, 50, 100].map(size =>
                    mk_button(`${size}²`, ev => {
                        this.root.elements['size_x'].value = size;
                        this.root.elements['size_y'].value = size;
                    }),
                )),
            ),
            mk('dt', "Viewport"),
            mk('dd',
                mk('label',
                    mk('input', {name: 'viewport', type: 'radio', value: '10'}),
                    " 10×10 (Chip's Challenge 2 size)"),
                mk('br'),
                mk('label',
                    mk('input', {name: 'viewport', type: 'radio', value: '9'}),
                    " 9×9 (Chip's Challenge 1 size)"),
                mk('br'),
                mk('label',
                    mk('input', {name: 'viewport', type: 'radio', value: '', disabled: 'disabled'}),
                    " Split 10×10 (not yet supported)"),
            ),
            mk('dt', "Blob behavior"),
            mk('dd',
                mk('label',
                    mk('input', {name: 'blob_behavior', type: 'radio', value: '0'}),
                    " Deterministic (PRNG + simple convolution)"),
                mk('br'),
                mk('label',
                    mk('input', {name: 'blob_behavior', type: 'radio', value: '1'}),
                    " 4 patterns (CC2 default; PRNG + rotating offset)"),
                mk('br'),
                mk('label',
                    mk('input', {name: 'blob_behavior', type: 'radio', value: '2'}),
                    " Extra random (LL default; initial seed is truly random)"),
            ),
            mk('dt', "Options"),
            mk('dd', mk('label',
                mk('input', {name: 'hide_logic', type: 'checkbox'}),
                " Hide wires and logic gates (warning: CC2 also hides pink/black buttons!)")),
            mk('dd', mk('label',
                mk('input', {name: 'use_cc1_boots', type: 'checkbox'}),
                " Use CC1-style inventory (can only pick up the four classic boots; can't drop or cycle)")),
        );
        this.root.elements['viewport'].value = stored_level.viewport_size;
        this.root.elements['blob_behavior'].value = stored_level.blob_behavior;
        this.root.elements['hide_logic'].checked = stored_level.hide_logic;
        this.root.elements['use_cc1_boots'].checked = stored_level.use_cc1_boots;
        // TODO:
        // - chips?
        // - password???
        // - comment
        // - use CC1 tools
        // - hide logic
        // - "unviewable", "read only"

        this.add_button("save", () => {
            let els = this.root.elements;

            let title = els.title.value;
            if (title !== stored_level.title) {
                stored_level.title = title;
                this.conductor.stored_game.level_metadata[this.conductor.level_index].title = title;
                this.conductor.update_level_title();
            }
            let author = els.author.value;
            if (author !== stored_level.author) {
                stored_level.author = author;
            }

            // FIXME gotta deal with NaNs here too, sigh, might just need a teeny tiny form library
            stored_level.time_limit = Math.max(0, Math.min(65535, parseInt(els.time_limit.value, 10)));

            let size_x = Math.max(1, Math.min(100, parseInt(els.size_x.value, 10)));
            let size_y = Math.max(1, Math.min(100, parseInt(els.size_y.value, 10)));
            if (size_x !== stored_level.size_x || size_y !== stored_level.size_y) {
                this.conductor.editor.resize_level(size_x, size_y);
            }

            stored_level.blob_behavior = parseInt(els.blob_behavior.value, 10);
            stored_level.hide_logic = els.hide_logic.checked;
            stored_level.use_cc1_boots = els.use_cc1_boots.checked;
            let viewport_size = parseInt(els.viewport.value, 10);
            if (viewport_size !== 9 && viewport_size !== 10) {
                viewport_size = 10;
            }
            stored_level.viewport_size = viewport_size;
            this.conductor.player.update_viewport_size();

            this.close();
        });
        this.add_button("nevermind", () => {
            this.close();
        });
    }
}

// List of levels, used in the player
class EditorLevelBrowserOverlay extends DialogOverlay {
    constructor(conductor) {
        super(conductor);
        this.set_title("choose a level");

        // Set up some infrastructure to lazily display level renders
        // FIXME should this use the tileset appropriate for the particular level?
        this.renderer = new CanvasRenderer(this.conductor.tilesets['ll'], 32);
        this.awaiting_renders = [];
        this.observer = new IntersectionObserver((entries, observer) => {
                let any_new = false;
                let to_remove = new Set;
                for (let entry of entries) {
                    if (entry.target.classList.contains('--rendered'))
                        continue;

                    let index = this._get_index(entry.target);
                    if (entry.isIntersecting) {
                        this.awaiting_renders.push(index);
                        any_new = true;
                    }
                    else {
                        to_remove.add(index);
                    }
                }

                this.awaiting_renders = this.awaiting_renders.filter(index => ! to_remove.has(index));
                if (any_new) {
                    this.schedule_level_render();
                }
            },
            { root: this.main },
        );
        this.list = mk('ol.editor-level-browser');
        this.selection = this.conductor.level_index;
        for (let [i, meta] of conductor.stored_game.level_metadata.entries()) {
            this.list.append(this._make_list_item(i, meta));
        }
        this.list.childNodes[this.selection].classList.add('--selected');
        this.main.append(
            mk('p', "Drag to rearrange.  Changes are immediate!"),
            this.list,
        );

        this.list.addEventListener('click', ev => {
            let index = this._get_index(ev.target);
            if (index === null)
                return;
            this._select(index);
        });
        this.list.addEventListener('dblclick', ev => {
            let index = this._get_index(ev.target);
            if (index !== null && this.conductor.change_level(index)) {
                this.close();
            }
        });

        this.sortable = new Sortable(this.list, {
            group: 'editor-levels',
            onEnd: ev => {
                if (ev.oldIndex === ev.newIndex)
                    return;

                this._move_level(ev.oldIndex, ev.newIndex);

                this.undo_stack.push(() => {
                    this.list.insertBefore(
                        this.list.childNodes[ev.newIndex],
                        this.list.childNodes[ev.oldIndex + (ev.oldIndex < ev.newIndex ? 0 : 1)]);
                    this._move_level(ev.newIndex, ev.oldIndex);
                });
                this.undo_button.disabled = false;
            },
        });

        // FIXME ring buffer?
        this.undo_stack = [];

        // Left buttons
        this.undo_button = this.add_button("undo", ev => {
            if (! this.undo_stack.length)
                return;

            let undo = this.undo_stack.pop();
            undo();
            this.undo_button.disabled = ! this.undo_stack.length;
        });
        this.undo_button.disabled = true;
        this.add_button("create", ev => {
            let index = this.selection + 1;
            let stored_level = this.conductor.editor._make_empty_level(index + 1, 32, 32);
            this.conductor.editor.move_level(stored_level, index);
            this._after_insert_level(stored_level, index);

            this.undo_stack.push(() => {
                this._delete_level(index);
            });
            this.undo_button.disabled = false;
        });
        this.add_button("duplicate", ev => {
            let index = this.selection + 1;
            let stored_level = this.conductor.editor.duplicate_level(this.selection);
            this._after_insert_level(stored_level, index);

            this.undo_stack.push(() => {
                this._delete_level(index);
            });
            this.undo_button.disabled = false;
        });
        this.delete_button = this.add_button("delete", ev => {
            let index = this.selection;
            if (index === this.conductor.level_index) {
                new AlertOverlay(this.conductor, "You can't delete the level you have open.").open();
                return;
            }

            // Snag a copy of the serialized level for undo purposes
            // FIXME can't undo deleting a corrupt level
            let meta = this.conductor.stored_game.level_metadata[index];
            let serialized_level = window.localStorage.getItem(meta.key);

            this._delete_level(index);

            this.undo_stack.push(() => {
                let stored_level = meta.stored_level ?? c2g.parse_level(
                    bytestring_to_buffer(serialized_level), index + 1);
                this.conductor.editor.move_level(stored_level, index);
                if (this.selection >= index) {
                    this.selection += 1;
                }
                this._after_insert_level(stored_level, index);
            });
            this.undo_button.disabled = false;
        });
        this._update_delete_button();

        // Right buttons
        this.add_button_gap();
        this.add_button("open", ev => {
            if (this.selection === this.conductor.level_index || this.conductor.change_level(this.selection)) {
                this.close();
            }
        });
        this.add_button("nevermind", ev => {
            this.close();
        });
    }

    _make_list_item(index, meta) {
        let li = mk('li',
            {'data-index': index},
            mk('div.-preview'),
            mk('div.-number', {}, meta.number),
            mk('div.-title', {}, meta.error ? "(error!)" : meta.title),
        );

        if (meta.error) {
            li.classList.add('--error');
        }
        else {
            this.observer.observe(li);
        }

        return li;
    }

    renumber_levels(start_index, end_index = null) {
        end_index = end_index ?? this.conductor.stored_game.level_metadata.length - 1;
        for (let i = start_index; i <= end_index; i++) {
            let li = this.list.childNodes[i];
            let meta = this.conductor.stored_game.level_metadata[i];
            li.setAttribute('data-index', i);
            li.querySelector('.-number').textContent = meta.number;
        }
    }

    _get_index(element) {
        let li = element.closest('li');
        if (! li)
            return null;

        return parseInt(li.getAttribute('data-index'), 10);
    }

    _select(index) {
        this.list.childNodes[this.selection].classList.remove('--selected');
        this.selection = index;
        this.list.childNodes[this.selection].classList.add('--selected');
        this._update_delete_button();
    }

    _update_delete_button() {
        this.delete_button.disabled = !! (this.selection === this.conductor.level_index);
    }

    schedule_level_render() {
        if (this._handle)
            return;
        this._handle = setTimeout(() => { this.render_level() }, 50);
    }

    render_level() {
        this._handle = null;

        let t0 = performance.now();
        while (true) {
            if (this.awaiting_renders.length === 0)
                return;

            let index = this.awaiting_renders.shift();
            let element = this.list.childNodes[index];
            // FIXME levels may have been renumbered since this was queued, whoops
            let stored_level = this.conductor.stored_game.load_level(index);
            this.renderer.set_level(stored_level);
            this.renderer.set_viewport_size(stored_level.size_x, stored_level.size_y);
            this.renderer.draw_static_region(0, 0, stored_level.size_x, stored_level.size_y);
            let canvas = mk('canvas', {
                width: stored_level.size_x * this.renderer.tileset.size_x / 4,
                height: stored_level.size_y * this.renderer.tileset.size_y / 4,
            });
            canvas.getContext('2d').drawImage(this.renderer.canvas, 0, 0, canvas.width, canvas.height);
            element.querySelector('.-preview').append(canvas);
            element.classList.add('--rendered');

            if (performance.now() - t0 > 10)
                break;
        }

        this.schedule_level_render();
    }

    expire(index) {
        let li = this.list.childNodes[index];
        li.classList.remove('--rendered');
        li.querySelector('.-preview').textContent = '';
    }

    _after_insert_level(stored_level, index) {
        this.list.insertBefore(
            this._make_list_item(index, this.conductor.stored_game.level_metadata[index]),
            this.list.childNodes[index]);
        this._select(index);
        this.renumber_levels(index + 1);
    }

    _delete_level(index) {
        let num_levels = this.conductor.stored_game.level_metadata.length;
        let stored_level = this.conductor.editor.move_level(index, null);

        this.list.childNodes[this.selection].classList.remove('--selected');
        this.list.childNodes[index].remove();
        if (index === num_levels - 1) {
            this.selection -= 1;
        }
        else {
            this.renumber_levels(index);
        }
        this.list.childNodes[this.selection].classList.add('--selected');
    }

    _move_level(from_index, to_index) {
        this.conductor.editor.move_level(from_index, to_index);

        let selection = this.selection;
        if (from_index < to_index) {
            this.renumber_levels(from_index, to_index);
            if (from_index < selection && selection <= to_index) {
                selection -= 1;
            }
        }
        else {
            this.renumber_levels(to_index, from_index);
            if (to_index <= selection && selection < from_index) {
                selection += 1;
            }
        }

        if (this.selection === from_index) {
            this.selection = to_index;
        }
        else {
            this.selection = selection;
        }
        this._update_delete_button();
    }
}

class EditorShareOverlay extends DialogOverlay {
    constructor(conductor, url) {
        super(conductor);
        this.set_title("give this to friends");
        this.main.append(mk('p', "Give this URL out to let others try your level:"));
        this.main.append(mk('p.editor-share-url', {}, url));
        let copy_button = mk('button', {type: 'button'}, "Copy to clipboard");
        copy_button.addEventListener('click', ev => {
            flash_button(ev.target);
            navigator.clipboard.writeText(url);
        });
        this.main.append(copy_button);

        let ok = mk('button', {type: 'button'}, "neato");
        ok.addEventListener('click', ev => {
            this.close();
        });
        this.footer.append(ok);
    }
}

class EditorExportFailedOverlay extends DialogOverlay {
    constructor(conductor, errors, warnings) {
        // TODO support warnings i guess
        super(conductor);
        this.set_title("export didn't go so well");
        this.main.append(mk('p', "Whoops!  I tried very hard to export your level, but it didn't work out.  Sorry."));
        let ul = mk('ul.editor-export-errors');
        // TODO structure the errors better and give them names out here, also reduce duplication,
        // also be clear about which are recoverable or not
        for (let error of errors) {
            ul.append(mk('li', error));
        }
        this.main.append(ul);
        this.add_button("oh well", ev => {
            this.close();
        });
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Mouse tool handling

// Handles mouse activity for a given tool, whether the mouse button is current held or not.  (When
// the mouse button is /not/ held, then only tools bound to the left mouse button gets events.)
const MOUSE_BUTTON_MASKS = [1, 4, 2];  // MouseEvent.button/buttons are ordered differently
class MouseOperation {
    constructor(editor, client_x, client_y, physical_button) {
        this.editor = editor;
        this.is_held = false;
        this.physical_button = physical_button;
        this.alt_mode = physical_button !== 0;
        this.ctrl = false;
        this.shift = false;
        //this._update_modifiers(ev);  // FIXME how do i get this initially??

        let [frac_cell_x, frac_cell_y] = this.editor.renderer.real_cell_coords_from_event({clientX: client_x, clientY: client_y});
        let cell_x = Math.floor(frac_cell_x);
        let cell_y = Math.floor(frac_cell_y);

        // Client coordinates of the previous mouse event
        this.prev_client_x = client_x;
        this.prev_client_y = client_y;
        // Cell coordinates
        this.prev_cell_x = cell_x;
        this.prev_cell_y = cell_y;
        // Fractional cell coordinates
        this.prev_frac_cell_x = frac_cell_x;
        this.prev_frac_cell_y = frac_cell_y;

        // Same as above, but for the most recent click (so drag ops know where they started)
        this.click_client_x = null;
        this.click_client_y = null;
        this.click_cell_x = null;
        this.click_cell_y = null;
        this.click_frac_cell_x = null;
        this.click_frac_cell_y = null;

        // Start out with a hover effect
        // FIXME no good, subclass hasn't finished setting itself up yet
        //this.do_move({clientX: client_x, clientY: client_y});
    }

    cell(x, y) {
        return this.editor.cell(Math.floor(x), Math.floor(y));
    }

    do_press(ev) {
        this.is_held = true;
        this._update_modifiers(ev);

        this.client_x = ev.clientX;
        this.client_y = ev.clientY;
        [this.click_frac_cell_x, this.click_frac_cell_y] = this.editor.renderer.real_cell_coords_from_event(ev);
        this.click_cell_x = Math.floor(this.click_frac_cell_x);
        this.click_cell_y = Math.floor(this.click_frac_cell_y);

        this.prev_client_x = this.client_x;
        this.prev_client_y = this.client_y;
        this.prev_frac_cell_x = this.click_frac_cell_x;
        this.prev_frac_cell_y = this.click_frac_cell_y;
        this.prev_cell_x = this.click_cell_x;
        this.prev_cell_y = this.click_cell_y;

        this.handle_press(this.click_cell_x, this.click_cell_y, ev);
    }

    do_move(ev) {
        this._update_modifiers(ev);
        let [frac_cell_x, frac_cell_y] = this.editor.renderer.real_cell_coords_from_event(ev);
        let cell_x = Math.floor(frac_cell_x);
        let cell_y = Math.floor(frac_cell_y);

        if (this.is_held && (ev.buttons & MOUSE_BUTTON_MASKS[this.physical_button]) === 0) {
            this.do_abort();
        }

        if (this.is_held) {
            // Continue a drag even if the mouse goes outside the viewport
            this.handle_drag(ev.clientX, ev.clientY, frac_cell_x, frac_cell_y, cell_x, cell_y);
        }
        else {
            // This is a hover, which has separate behavior for losing track of the mouse.  Note
            // that we can't just check if the cell coordinates are valid; we also need to know that
            // the mouse is actually over the visible viewport (the canvas may have scrolled!)
            let in_bounds = false;
            if (this.editor.is_in_bounds(cell_x, cell_y)) {
                let rect = this.editor.actual_viewport_el.getBoundingClientRect();
                let cx = ev.clientX, cy = ev.clientY;
                if (rect.left <= cx && cx < rect.right && rect.top <= cy && cy < rect.bottom) {
                    in_bounds = true;
                }
            }

            if (in_bounds) {
                this.show();
                this.handle_hover(ev.clientX, ev.clientY, frac_cell_x, frac_cell_y, cell_x, cell_y);
            }
            else {
                this.hide();
                this.handle_leave();
            }
        }

        this.prev_client_x = ev.clientX;
        this.prev_client_y = ev.clientY;
        this.prev_frac_cell_x = frac_cell_x;
        this.prev_frac_cell_y = frac_cell_y;
        this.prev_cell_x = cell_x;
        this.prev_cell_y = cell_y;
    }

    do_leave() {
        this.hide();
    }

    show() {
        if (! this.is_hover_visible) {
            this.is_hover_visible = true;
            this.editor.preview_g.style.display = '';
        }
    }

    hide() {
        if (this.is_hover_visible) {
            this.is_hover_visible = false;
            this.editor.preview_g.style.display = 'none';
        }
    }

    _update_modifiers(ev) {
        this.ctrl = ev.ctrlKey;
        this.shift = ev.shiftKey;
    }

    do_commit() {
        if (! this.is_held)
            return;

        this.commit_press();
        this.cleanup_press();
        this.is_held = false;
    }

    do_abort() {
        if (! this.is_held)
            return;

        this.abort_press();
        this.cleanup_press();
        this.is_held = false;
    }

    do_destroy() {
        this.do_abort();
        this.cleanup_hover();
    }

    *iter_touched_cells(frac_cell_x, frac_cell_y) {
        for (let pt of walk_grid(
            this.prev_frac_cell_x, this.prev_frac_cell_y, frac_cell_x, frac_cell_y,
            // Bound the grid walk to one cell beyond the edges of the level, so that dragging the
            // mouse in from outside the actual edges still works reliably
            -1, -1, this.editor.stored_level.size_x, this.editor.stored_level.size_y))
        {
            if (this.editor.is_in_bounds(...pt)) {
                yield pt;
            }
        }
    }

    // -- Implement these --

    // Called when the mouse button is first pressed
    handle_press(x, y, ev) {}
    // Called when the mouse is moved while the button is held down
    handle_drag(client_x, client_y, frac_cell_x, frac_cell_y, cell_x, cell_y) {}
    // Called when releasing the mouse button
    commit_press() {}
    // Called when aborting a held mouse, e.g. by pressing Esc or losing focus
    abort_press() {}
    // Called after either of the above cases
    cleanup_press() {}

    // Called when the mouse is moved while the button is NOT held down
    handle_hover(client_x, client_y, frac_cell_x, frac_cell_y, cell_x, cell_y) {}
    // Called when the foreground or background tile changes (after it's been redrawn)
    handle_tile_updated(is_bg = false) {}
    // Called when the mouse leaves the level or viewport while the button is NOT held down
    handle_leave() {}
    // Called when the hover ends??
    cleanup_hover() {}
}

class PanOperation extends MouseOperation {
    handle_drag(client_x, client_y) {
        let target = this.editor.actual_viewport_el;
        let dx = this.prev_client_x - client_x;
        let dy = this.prev_client_y - client_y;
        target.scrollLeft += dx;
        target.scrollTop += dy;
    }
}

class EyedropOperation extends MouseOperation {
    constructor(...args) {
        super(...args);
        // Last coordinates we clicked on
        // FIXME whoops, storing this state locally doesn't work since we're destroyed between
        // clicks lol!  clean fix is to make an op immediately and persist it even when mouse isn't
        // down?  then the hover stuff could be rolled into the tool too?  kind of a big change tho
        // so for now let's cheat and hack it onto the editor itself
        this.last_eyedropped_coords = null;
        this.last_layer = null;
    }

    eyedrop(x, y) {
        let cell = this.cell(x, y);
        if (! cell) {
            this.last_eyedropped_coords = null;
            return;
        }

        // If we're picking the background, we always use the terrain
        if (this.ctrl) {
            this.editor.select_background_tile(cell[LAYERS.terrain]);
            return;
        }

        // Pick the topmost thing, unless we're clicking on a cell repeatedly, in which case we
        // continue from below the last thing we picked
        let layer_offset = 0;
        if (this.last_eyedropped_coords &&
            this.last_eyedropped_coords[0] === x && this.last_eyedropped_coords[1] === y)
        {
            layer_offset = this.last_layer;
        }
        for (let l = LAYERS.MAX - 1; l >= 0; l--) {
            // This scheme means we'll cycle back around after hitting the bottom
            let layer = (l + layer_offset) % LAYERS.MAX;
            let tile = cell[layer];
            if (! tile)
                continue;

            this.editor.select_foreground_tile(tile);
            this.last_eyedropped_coords = [x, y];
            this.last_layer = layer;
            return;
        }
    }

    handle_press(x, y) {
        this.eyedrop(x, y);
    }
    handle_drag(x, y) {
        // FIXME should only re-eyedrop if we enter a new cell or click again
        this.eyedrop(x, y);
    }
}


class PencilOperation extends MouseOperation {
    constructor(...args) {
        super(...args);

        this.image = mk_svg('image', {
            id: 'svg-editor-preview-tile',
            x: 0,
            y: 0,
            width: 1,
            height: 1,
        });
        this.editor.preview_g.append(this.image);
        this.handle_tile_updated();
    }

    // Hover: draw the tile in the pointed-to cell
    handle_tile_updated(is_bg = false) {
        if (is_bg)
            return;
        this.image.setAttribute('href', this.editor.fg_tile_el.toDataURL());
    }
    handle_hover(_mx, _my, _cxf, _cyf, cell_x, cell_y) {
        this.image.setAttribute('x', cell_x);
        this.image.setAttribute('y', cell_y);
    }
    cleanup_hover() {
        this.image.remove();
    }

    handle_press(x, y) {
        this.draw_in_cell(x, y);
    }
    handle_drag(client_x, client_y, frac_cell_x, frac_cell_y, cell_x, cell_y) {
        for (let [x, y] of this.iter_touched_cells(frac_cell_x, frac_cell_y)) {
            this.draw_in_cell(x, y);
        }
    }

    draw_in_cell(x, y) {
        let template = this.editor.fg_tile;
        let cell = this.cell(x, y);
        if (this.ctrl) {
            // Erase
            if (this.shift) {
                // Wipe the whole cell
                let new_cell = this.editor.make_blank_cell(x, y);
                this.editor.replace_cell(cell, new_cell);
            }
            else if (template) {
                // Erase whatever's on the same layer as the fg tile
                this.editor.erase_tile(cell);
            }
        }
        else {
            // Draw
            if (! template)
                return;
            if (this.shift) {
                // Aggressive mode: replace whatever's already in the cell
                let new_cell = this.editor.make_blank_cell(x, y);
                new_cell[template.type.layer] = {...template};
                this.editor.replace_cell(cell, new_cell);
            }
            else {
                // Default operation: only replace whatever's on the same layer
                this.editor.place_in_cell(cell, template);
            }
        }
    }

    cleanup_press() {
        this.editor.commit_undo();
    }
}

// FIXME still to do on this:
// - doesn't know to update canvas size or erase results when a new level is loaded OR when the
// level size changes (and for that matter the selection tool doesn't either)
// - hold shift to replace all of the same tile in the whole level?  (need to know when shift is
// toggled)
// - right-click to pick, same logic as pencil (which needs improving)
// - ctrl-click to erase
// - reset the preview after a fill?  is that ever necessary?
class FillOperation extends MouseOperation {
    constructor(...args) {
        super(...args);
        let renderer = this.editor.renderer;
        this.canvas = mk('canvas', {
            width: renderer.canvas.width,
            height: renderer.canvas.height,
        });
        this.foreign_object = mk_svg('foreignObject', {
            x: 0, y: 0,
            width: this.canvas.width, height: this.canvas.height,
            transform: `scale(${1/renderer.tileset.size_x} ${1/renderer.tileset.size_y})`,
        }, this.canvas);
        this.editor.preview_g.append(this.foreign_object);

        // array of (true: in flood, false: definitely not), or null if not yet populated
        this.fill_state = null;
        // Last coordinates we updated from
        // FIXME probably not necessary now?
        this.last_known_coords = null;
        // Palette tile we last flooded with
        this.last_known_tile = this.editor.fg_tile;
    }

    handle_hover(_mx, _my, _gxf, _gyf, cell_x, cell_y) {
        this.last_known_coords = [cell_x, cell_y];
        this.last_known_tile = this.editor.fg_tile;
        this._floodfill_from(cell_x, cell_y);
    }
    _floodfill_from(x0, y0) {
        let i0 = this.editor.stored_level.coords_to_scalar(x0, y0);
        if (this.fill_state && this.fill_state[i0]) {
            // This cell is already part of the pending fill, so there's nothing to do
            return;
        }

        let stored_level = this.editor.stored_level;
        let tile = this.editor.fg_tile;
        let layer = tile.type.layer;
        let tile0 = stored_level.linear_cells[i0][layer] ?? null;
        let type0 = tile0 ? tile0.type : null;

        if (! this.editor.selection.contains(x0, y0)) {
            this.fill_state = null;
            this._redraw();
            return;
        }

        // Aaand, floodfill
        this.fill_state = new Array(stored_level.linear_cells.length);
        this.fill_state[i0] = true;
        let pending = [i0];
        let steps = 0;
        while (pending.length > 0) {
            let old_pending = pending;
            pending = [];
            for (let i of old_pending) {
                let [x, y] = stored_level.scalar_to_coords(i);

                // Check neighbors
                for (let dirinfo of Object.values(DIRECTIONS)) {
                    let [dx, dy] = dirinfo.movement;
                    let nx = x + dx;
                    let ny = y + dy;
                    let j = stored_level.coords_to_scalar(nx, ny)
                    if (! this.editor.selection.contains(nx, ny)) {
                        this.fill_state[j] = false;
                        continue;
                    }

                    let cell = this.editor.cell(nx, ny);
                    if (cell) {
                        if (this.fill_state[j] !== undefined)
                            continue;

                        let tile = cell[layer] ?? null;
                        let type = tile ? tile.type : null;
                        if (type === type0) {
                            this.fill_state[j] = true;
                            pending.push(j);
                        }
                        else {
                            this.fill_state[j] = false;
                        }
                    }
                }
                steps++;
                if (steps > 10000) {
                    console.error("more steps than should be possible");
                    return;
                }
            }
        }

        this._redraw();
    }

    _redraw() {
        // Draw all the good tiles
        let ctx = this.canvas.getContext('2d');
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (! this.fill_state)
            return;

        let stored_level = this.editor.stored_level;
        let tileset = this.editor.renderer.tileset;
        let source = this.editor.fg_tile_el;
        for (let [i, ok] of this.fill_state.entries()) {
            if (! ok)
                continue;

            let [x, y] = stored_level.scalar_to_coords(i);
            ctx.drawImage(source, x * tileset.size_x, y * tileset.size_y);
        }
    }

    handle_tile_updated(is_bg = false) {
        if (is_bg)
            // TODO
            return;

        // Figure out whether the floodfill results changed.  If the new tile is on the same layer
        // as the old tile, we can reuse the results and just redraw.  If not, recompute everything
        // (unless we're hidden, in which case blow it away and just do nothing).
        if (this.editor.fg_tile.type.layer === this.last_known_tile.type.layer) {
            if (this.fill_state) {
                this._redraw();
            }
        }
        else {
            this.fill_state = null;
            if (this.last_known_coords && ! this.hidden) {
                this._floodfill_from(...this.last_known_coords);
            }
        }
    }

    cleanup_hover() {
        this.foreign_object.remove();
    }

    handle_press(x, y) {
        // Filling is a single-click thing, and all the work was done while hovering
        if (! this.fill_state) {
            // Something has gone terribly awry (or they clicked outside the level)
            return;
        }

        let stored_level = this.editor.stored_level;
        let template = this.editor.fg_tile;
        for (let [i, ok] of this.fill_state.entries()) {
            if (! ok)
                continue;

            let cell = this.editor.cell(...stored_level.scalar_to_coords(i));
            this.editor.place_in_cell(cell, template);
        }
        this.editor.commit_undo();
    }
}


// TODO also, delete
// TODO also, non-rectangular selections
// TODO also, better marching ants, hard to see on gravel
class SelectOperation extends MouseOperation {
    handle_press(x, y) {
        if (! this.editor.selection.is_empty && this.editor.selection.contains(this.click_cell_x, this.click_cell_y)) {
            // Move existing selection
            this.mode = 'float';
            if (this.ctrl) {
                this.make_copy = true;
            }
        }
        else {
            // Create new selection
            this.mode = 'create';
            this.pending_selection = this.editor.selection.create_pending();
            this.update_pending_selection();
        }
        this.has_moved = false;
    }
    handle_drag(client_x, client_y, frac_cell_x, frac_cell_y, cell_x, cell_y) {
        if (this.mode === 'float') {
            if (this.has_moved) {
                this.editor.selection.move_by(Math.floor(cell_x - this.prev_cell_x), Math.floor(cell_y - this.prev_cell_y));
                return;
            }

            if (this.make_copy) {
                if (this.editor.selection.is_floating) {
                    // Stamp the floating selection but keep it floating
                    this.editor.selection.stamp_float(true);
                }
                else {
                    this.editor.selection.enfloat(true);
                }
            }
            else if (! this.editor.selection.is_floating) {
                this.editor.selection.enfloat();
            }
        }
        else {
            this.update_pending_selection();
        }
        this.has_moved = true;
    }

    update_pending_selection() {
        this.pending_selection.set_extrema(this.click_cell_x, this.click_cell_y, this.prev_cell_x, this.prev_cell_y);
    }

    commit_press() {
        if (this.mode === 'float') {
            // Make selection move undoable
            let dx = Math.floor(this.prev_cell_x - this.click_cell_x);
            let dy = Math.floor(this.prev_cell_y - this.click_cell_y);
            if (dx || dy) {
                this.editor._done(
                    () => this.editor.selection.move_by(dx, dy),
                    () => this.editor.selection.move_by(-dx, -dy),
                );
            }
        }
        else {
            // If there's an existing floating selection (which isn't what we're operating on),
            // commit it before doing anything else
            this.editor.selection.defloat();
            if (! this.has_moved) {
                // Plain click clears selection
                this.pending_selection.discard();
                this.editor.selection.clear();
            }
            else {
                this.pending_selection.commit();
            }
        }
        this.editor.commit_undo();
    }
    abort_press() {
        if (this.mode === 'float') {
            // FIXME revert the move?
        }
        else {
            this.pending_selection.discard();
        }
    }
}

class ForceFloorOperation extends MouseOperation {
    handle_press(x, y) {
        // Begin by placing an all-way force floor under the mouse
        this.editor.place_in_cell(this.cell(x, y), {type: TILE_TYPES.force_floor_all});
    }
    handle_drag(client_x, client_y, frac_cell_x, frac_cell_y) {
        // Walk the mouse movement and change each we touch to match the direction we
        // crossed the border
        // FIXME occasionally i draw a tetris S kinda shape and both middle parts point
        // the same direction, but shouldn't
        let i = 0;
        let prevx, prevy;
        for (let [x, y] of this.iter_touched_cells(frac_cell_x, frac_cell_y)) {
            i++;
            // The very first cell is the one the mouse was already in, and we don't
            // have a movement direction yet, so leave that alone
            if (i === 1) {
                prevx = x;
                prevy = y;
                continue;
            }
            let name;
            if (x === prevx) {
                if (y > prevy) {
                    name = 'force_floor_s';
                }
                else {
                    name = 'force_floor_n';
                }
            }
            else {
                if (x > prevx) {
                    name = 'force_floor_e';
                }
                else {
                    name = 'force_floor_w';
                }
            }

            // The second cell tells us the direction to use for the first, assuming it
            // had some kind of force floor
            if (i === 2) {
                let prevcell = this.editor.cell(prevx, prevy);
                if (prevcell[LAYERS.terrain].type.name.startsWith('force_floor_')) {
                    this.editor.place_in_cell(prevcell, {type: TILE_TYPES[name]});
                }
            }

            // Drawing a loop with force floors creates ice (but not in the previous
            // cell, obviously)
            let cell = this.editor.cell(x, y);
            if (cell[LAYERS.terrain].type.name.startsWith('force_floor_') &&
                cell[LAYERS.terrain].type.name !== name)
            {
                name = 'ice';
            }
            this.editor.place_in_cell(cell, {type: TILE_TYPES[name]});

            prevx = x;
            prevy = y;
        }
    }
    cleanup_press() {
        this.editor.commit_undo();
    }
}

// TODO entered cell should get blank railroad?
// TODO maybe place a straight track in the new cell so it looks like we're doing something, then
// fix it if it wasn't there?
// TODO gonna need an ice tool too, so maybe i can merge all three with some base thing that tracks
// the directions the mouse is moving?  or is FF tool too different?
class TrackOperation extends MouseOperation {
    handle_press(x, y) {
        // Do nothing to start; we only lay track when the mouse leaves a cell
        this.entry_direction = null;
    }
    handle_drag(client_x, client_y, frac_cell_x, frac_cell_y) {
        // Walk the mouse movement and, for every tile we LEAVE, add a railroad track matching the
        // two edges of it that we crossed.
        let prevx = null, prevy = null;
        for (let [x, y] of this.iter_touched_cells(frac_cell_x, frac_cell_y)) {
            if (prevx === null || prevy === null) {
                prevx = x;
                prevy = y;
                continue;
            }

            // Figure out which way we're leaving the tile
            let exit_direction;
            if (x === prevx) {
                if (y > prevy) {
                    exit_direction = 'south';
                }
                else {
                    exit_direction = 'north';
                }
            }
            else {
                if (x > prevx) {
                    exit_direction = 'east';
                }
                else {
                    exit_direction = 'west';
                }
            }

            // If the entry direction is missing or bogus, lay straight track
            if (this.entry_direction === null || this.entry_direction === exit_direction) {
                this.entry_direction = DIRECTIONS[exit_direction].opposite;
            }

            // Get the corresponding bit
            let bit = null;
            for (let [i, track] of TILE_TYPES['railroad'].track_order.entries()) {
                if ((track[0] === this.entry_direction && track[1] === exit_direction) ||
                    (track[1] === this.entry_direction && track[0] === exit_direction))
                {
                    bit = 1 << i;
                    break;
                }
            }

            if (bit === null)
                continue;

            // Update the cell we just left
            let cell = this.cell(prevx, prevy);
            let terrain = cell[0];
            if (terrain.type.name === 'railroad') {
                let new_terrain = {...terrain};
                if (this.ctrl) {
                    // Erase
                    // TODO fix track switch?
                    // TODO if this leaves tracks === 0, replace with floor?
                    new_terrain.tracks &= ~bit;
                }
                else {
                    // Draw
                    new_terrain.tracks |= bit;
                }
                this.editor.place_in_cell(cell, new_terrain);
            }
            else if (! this.ctrl) {
                terrain = { type: TILE_TYPES['railroad'] };
                terrain.type.populate_defaults(terrain);
                terrain.tracks |= bit;
                this.editor.place_in_cell(cell, terrain);
            }

            prevx = x;
            prevy = y;
            this.entry_direction = DIRECTIONS[exit_direction].opposite;
        }
    }
    cleanup_press() {
        this.editor.commit_undo();
    }
}

class SVGConnection {
    constructor(sx, sy, dx, dy) {
        this.source = mk_svg('rect.-source', {width: 1, height: 1});
        this.line = mk_svg('line.-arrow', {});
        this.element = mk_svg('g.overlay-connection', this.source, this.line);
        this.set_source(sx, sy);
        this.set_dest(dx, dy);
    }

    set_source(sx, sy) {
        this.sx = sx;
        this.sy = sy;
        this.source.setAttribute('x', sx);
        this.source.setAttribute('y', sy);
        this.line.setAttribute('x1', sx + 0.5);
        this.line.setAttribute('y1', sy + 0.5);
    }

    set_dest(dx, dy) {
        this.dx = dx;
        this.dy = dy;
        this.line.setAttribute('x2', dx + 0.5);
        this.line.setAttribute('y2', dy + 0.5);
    }
}
class ConnectOperation extends MouseOperation {
    handle_press(x, y, ev) {
        // TODO restrict to button/cloner unless holding shift
        // TODO what do i do when you erase a button/cloner?  can i detect if you're picking it up?
        let src = this.editor.stored_level.coords_to_scalar(x, y);
        if (this.alt_mode) {
            // Auto connect using Lynx rules
            let cell = this.cell(x, y);
            let terrain = cell[LAYERS.terrain];
            let other = null;
            let swap = false;
            if (terrain.type.name === 'button_red') {
                other = this.search_for(src, 'cloner', 1);
            }
            else if (terrain.type.name === 'cloner') {
                other = this.search_for(src, 'button_red', -1);
                swap = true;
            }
            else if (terrain.type.name === 'button_brown') {
                other = this.search_for(src, 'trap', 1);
            }
            else if (terrain.type.name === 'trap') {
                other = this.search_for(src, 'button_brown', -1);
                swap = true;
            }

            if (other !== null) {
                if (swap) {
                    this.editor.set_custom_connection(other, src);
                }
                else {
                    this.editor.set_custom_connection(src, other);
                }
                this.editor.commit_undo();
            }
            return;
        }
        this.pending_cxn = new SVGConnection(x, y, x, y);
        this.editor.svg_overlay.append(this.pending_cxn.element);
    }
    // FIXME this is hella the sort of thing that should be on Editor, or in algorithms
    search_for(i0, name, dir) {
        let l = this.editor.stored_level.linear_cells.length;
        let i = i0;
        while (true) {
            i += dir;
            if (i < 0) {
                i += l;
            }
            else if (i >= l) {
                i -= l;
            }
            if (i === i0)
                return null;

            let cell = this.editor.stored_level.linear_cells[i];
            let tile = cell[LAYERS.terrain];
            if (tile.type.name === name) {
                return i;
            }
        }
    }
    handle_drag(client_x, client_y, frac_cell_x, frac_cell_y, cell_x, cell_y) {
    }
    commit_press() {
    }
    abort_press() {
        this.pending_cxn.element.remove();
    }
    cleanup_press() {
    }
}
class WireOperation extends MouseOperation {
    handle_press(x, y) {
        if (this.alt_mode) {
            // Place or remove wire tunnels
            // TODO this could just be a separate tool now
            let cell = this.cell(this.click_frac_cell_x, this.click_frac_cell_y);
            if (! cell)
                return;

            let direction;
            // Use the offset from the center to figure out which edge of the tile to affect
            let xoff = this.click_frac_cell_x % 1 - 0.5;
            let yoff = this.click_frac_cell_y % 1 - 0.5;
            if (Math.abs(xoff) > Math.abs(yoff)) {
                if (xoff > 0) {
                    direction = 'east';
                }
                else {
                    direction = 'west';
                }
            }
            else {
                if (yoff > 0) {
                    direction = 'south';
                }
                else {
                    direction = 'north';
                }
            }
            let bit = DIRECTIONS[direction].bit;

            let terrain = cell[LAYERS.terrain];
            if (terrain.type.name === 'floor') {
                terrain = {...terrain};
                // TODO if this ever supports drag, remember whether we're adding or removing
                // initially
                if (terrain.wire_tunnel_directions & bit) {
                    terrain.wire_tunnel_directions &= ~bit;
                }
                else {
                    terrain.wire_tunnel_directions |= bit;
                }
                this.editor.place_in_cell(cell, terrain);
                this.editor.commit_undo();
            }
        }
    }
    handle_drag(client_x, client_y, frac_cell_x, frac_cell_y) {
        if (this.alt_mode) {
            // Wire tunnels don't support dragging
            // TODO but maybe they should??  makes erasing a lot of them easier at least
            return;
        }

        // Wire is interesting.  Consider this diagram.
        // +-------+
        // | . A . |
        // |...A...|
        // | . A . |
        // |BBB+CCC|
        // | . D . |
        // |...D...|
        // | . D . |
        // +-------+
        // In order to know which of the four wire pieces in a cell (A, B, C, D) someone is trying
        // to draw over, we use a quarter-size grid, indicated by the dots.  Then any mouse movement
        // that crosses the first horizontal grid line means we should draw wire A.
        // (Note that crossing either a tile boundary or the middle of a cell doesn't mean anything;
        // for example, dragging the mouse horizontally across the A wire is meaningless.)
        // TODO maybe i should just have a walk_grid variant that yields line crossings, christ
        let prevqx = null, prevqy = null;
        for (let [qx, qy] of walk_grid(
            this.prev_frac_cell_x * 4, this.prev_frac_cell_y * 4, frac_cell_x * 4, frac_cell_y * 4,
            // See comment in iter_touched_cells
            -1, -1, this.editor.stored_level.size_x * 4, this.editor.stored_level.size_y * 4))
        {
            if (prevqx === null || prevqy === null) {
                prevqx = qx;
                prevqy = qy;
                continue;
            }

            // Figure out which grid line we've crossed; direction doesn't matter, so we just get
            // the index of the line, which matches the coordinate of the cell to the right/bottom
            // FIXME 'continue' means we skip the update of prevs, solution is really annoying
            // FIXME if you trace around just the outside of a tile, you'll get absolute nonsense:
            // +---+---+
            // |   |   |
            // |   |.+ |
            // |   |.| |
            // +---+.--+
            // | ....  |
            // | +-|   |
            // |   |   |
            // +---+---+
            let wire_direction;
            let x, y;
            if (qx === prevqx) {
                // Vertical
                let line = Math.max(qy, prevqy);
                // Even crossings don't correspond to a wire
                if (line % 2 === 0) {
                    prevqx = qx;
                    prevqy = qy;
                    continue;
                }

                // Convert to real coordinates
                x = Math.floor(qx / 4);
                y = Math.floor(line / 4);

                if (line % 4 === 1) {
                    // Consult the diagram!
                    wire_direction = 'north';
                }
                else {
                    wire_direction = 'south';
                }
            }
            else {
                // Horizontal; same as above
                let line = Math.max(qx, prevqx);
                if (line % 2 === 0) {
                    prevqx = qx;
                    prevqy = qy;
                    continue;
                }

                x = Math.floor(line / 4);
                y = Math.floor(qy / 4);

                if (line % 4 === 1) {
                    wire_direction = 'west';
                }
                else {
                    wire_direction = 'east';
                }
            }

            if (! this.editor.is_in_bounds(x, y)) {
                prevqx = qx;
                prevqy = qy;
                continue;
            }

            let cell = this.cell(x, y);
            for (let tile of Array.from(cell).reverse()) {
                // TODO probably a better way to do this
                if (! tile)
                    continue;
                if (! tile.type.contains_wire)
                    continue;

                tile = {...tile};
                tile.wire_directions = tile.wire_directions ?? 0;
                if (this.ctrl) {
                    // Erase
                    tile.wire_directions &= ~DIRECTIONS[wire_direction].bit;
                }
                else {
                    // Draw
                    tile.wire_directions |= DIRECTIONS[wire_direction].bit;
                }
                this.editor.place_in_cell(cell, tile);
                break;
            }

            prevqx = qx;
            prevqy = qy;
        }
    }
    cleanup_press() {
        this.editor.commit_undo();
    }
}

// Tiles the "adjust" tool will turn into each other
const ADJUST_TOGGLES_CW = {};
const ADJUST_TOGGLES_CCW = {};
{
    for (let cycle of [
        ['chip', 'chip_extra'],
        // TODO shouldn't this convert regular walls into regular floors then?
        ['floor_custom_green', 'wall_custom_green'],
        ['floor_custom_pink', 'wall_custom_pink'],
        ['floor_custom_yellow', 'wall_custom_yellow'],
        ['floor_custom_blue', 'wall_custom_blue'],
        ['fake_floor', 'fake_wall'],
        ['popdown_floor', 'popdown_wall'],
        ['wall_invisible', 'wall_appearing'],
        ['green_floor', 'green_wall'],
        ['green_bomb', 'green_chip'],
        ['purple_floor', 'purple_wall'],
        ['thief_keys', 'thief_tools'],
        ['swivel_nw', 'swivel_ne', 'swivel_se', 'swivel_sw'],
        ['ice_nw', 'ice_ne', 'ice_se', 'ice_sw'],
        ['force_floor_n', 'force_floor_e', 'force_floor_s', 'force_floor_w'],
        ['ice', 'force_floor_all'],
        ['water', 'turtle'],
        ['no_player1_sign', 'no_player2_sign'],
        ['flame_jet_off', 'flame_jet_on'],
        ['light_switch_off', 'light_switch_on'],
        ['stopwatch_bonus', 'stopwatch_penalty'],
    ])
    {
        for (let [i, tile] of cycle.entries()) {
            let other = cycle[(i + 1) % cycle.length];
            ADJUST_TOGGLES_CW[tile] = other;
            ADJUST_TOGGLES_CCW[other] = tile;
        }
    }
}
class AdjustOperation extends MouseOperation {
    handle_press(x, y) {
        let cell = this.cell(this.prev_cell_x, this.prev_cell_y);
        if (this.ctrl) {
            for (let tile of cell) {
                if (tile && TILES_WITH_PROPS[tile.type.name] !== undefined) {
                    this.editor.open_tile_prop_overlay(
                        tile, cell, this.editor.renderer.get_cell_rect(cell.x, cell.y));
                    break;
                }
            }
            return;
        }
        let start_layer = this.shift ? 0 : LAYERS.MAX - 1;
        for (let layer = start_layer; layer >= 0; layer--) {
            let tile = cell[layer];
            if (! tile)
                continue;

            let rotated;
            tile = {...tile}; // TODO little inefficient
            if (this.alt_mode) {
                // Reverse, go counterclockwise
                rotated = this.editor.rotate_tile_left(tile);
            }
            else {
                rotated = this.editor.rotate_tile_right(tile);
            }
            if (rotated) {
                this.editor.place_in_cell(cell, tile);
                this.editor.commit_undo();
                break;
            }

            // Toggle tiles that go in obvious pairs
            let other = (this.alt_mode ? ADJUST_TOGGLES_CCW : ADJUST_TOGGLES_CW)[tile.type.name];
            if (other) {
                tile.type = TILE_TYPES[other];
                this.editor.place_in_cell(cell, tile);
                this.editor.commit_undo();
                break;
            }
        }
    }
    // Adjust tool doesn't support dragging
    // TODO should it?
    // TODO if it does then it should end as soon as you spawn a popup
}

// FIXME currently allows creating outside the map bounds and moving beyond the right/bottom, sigh
// FIXME undo
// TODO view is not especially visible
class CameraOperation extends MouseOperation {
    handle_press(x, y, ev) {
        this.offset_x = 0;
        this.offset_y = 0;
        this.resize_x = 0;
        this.resize_y = 0;

        let cursor;

        this.target = ev.target.closest('.overlay-camera');
        if (! this.target) {
            // Clicking in empty space creates a new camera region
            this.mode = 'create';
            cursor = 'move';
            this.region = new DOMRect(this.click_cell_x, this.click_cell_y, 1, 1);
            this.target = mk_svg('rect.overlay-camera', {
                x: this.click_cell_x, y: this.prev_cell_y, width: 1, height: 1,
                'data-region-index': this.editor.stored_level.camera_regions.length,
            });
            this.editor.connections_g.append(this.target);
        }
        else {
            this.region = this.editor.stored_level.camera_regions[parseInt(this.target.getAttribute('data-region-index'), 10)];

            // If we're grabbing an edge, resize it
            let rect = this.target.getBoundingClientRect();
            let grab_left = (this.click_client_x < rect.left + 16);
            let grab_right = (this.click_client_x > rect.right - 16);
            let grab_top = (this.click_client_y < rect.top + 16);
            let grab_bottom = (this.click_client_y > rect.bottom - 16);
            if (grab_left || grab_right || grab_top || grab_bottom) {
                this.mode = 'resize';

                if (grab_left) {
                    this.resize_edge_x = -1;
                }
                else if (grab_right) {
                    this.resize_edge_x = 1;
                }
                else {
                    this.resize_edge_x = 0;
                }

                if (grab_top) {
                    this.resize_edge_y = -1;
                }
                else if (grab_bottom) {
                    this.resize_edge_y = 1;
                }
                else {
                    this.resize_edge_y = 0;
                }

                if ((grab_top && grab_left) || (grab_bottom && grab_right)) {
                    cursor = 'nwse-resize';
                }
                else if ((grab_top && grab_right) || (grab_bottom && grab_left)) {
                    cursor = 'nesw-resize';
                }
                else if (grab_top || grab_bottom) {
                    cursor = 'ns-resize';
                }
                else {
                    cursor = 'ew-resize';
                }
            }
            else {
                this.mode = 'move';
                cursor = 'move';
            }
        }

        this.editor.viewport_el.style.cursor = cursor;

        // Create a text element to show the size while editing
        this.size_text = mk_svg('text.overlay-edit-tip', {
            // Center it within the rectangle probably (x and y are set in _update_size_text)
            'text-anchor': 'middle', 'dominant-baseline': 'middle',
        });
        this._update_size_text();
        this.editor.svg_overlay.append(this.size_text);
    }
    _update_size_text() {
        this.size_text.setAttribute('x', this.region.x + this.offset_x + (this.region.width + this.resize_x) / 2);
        this.size_text.setAttribute('y', this.region.y + this.offset_y + (this.region.height + this.resize_y) / 2);
        this.size_text.textContent = `${this.region.width + this.resize_x} × ${this.region.height + this.resize_y}`;
    }
    handle_drag(client_x, client_y, frac_cell_x, frac_cell_y, cell_x, cell_y) {
        // FIXME not right if we zoom, should use frac_cell_x
        let dx = Math.floor((client_x - this.click_client_x) / this.editor.renderer.tileset.size_x + 0.5);
        let dy = Math.floor((client_y - this.click_client_y) / this.editor.renderer.tileset.size_y + 0.5);

        let stored_level = this.editor.stored_level;
        if (this.mode === 'create') {
            // Just make the new region span between the original click and the new position
            this.region.x = Math.min(cell_x, this.click_cell_x);
            this.region.y = Math.min(cell_y, this.click_cell_y);
            this.region.width = Math.max(cell_x, this.click_cell_x) + 1 - this.region.x;
            this.region.height = Math.max(cell_y, this.click_cell_y) + 1 - this.region.y;
        }
        else if (this.mode === 'move') {
            // Keep it within the map!
            this.offset_x = Math.max(- this.region.x, Math.min(stored_level.size_x - this.region.width, dx));
            this.offset_y = Math.max(- this.region.y, Math.min(stored_level.size_y - this.region.height, dy));
        }
        else {
            // Resize, based on the edge we originally grabbed
            if (this.resize_edge_x < 0) {
                // Left
                dx = Math.max(-this.region.x, Math.min(this.region.width - 1, dx));
                this.resize_x = -dx;
                this.offset_x = dx;
            }
            else if (this.resize_edge_x > 0) {
                // Right
                dx = Math.max(-(this.region.width - 1), Math.min(stored_level.size_x - this.region.right, dx));
                this.resize_x = dx;
                this.offset_x = 0;
            }

            if (this.resize_edge_y < 0) {
                // Top
                dy = Math.max(-this.region.y, Math.min(this.region.height - 1, dy));
                this.resize_y = -dy;
                this.offset_y = dy;
            }
            else if (this.resize_edge_y > 0) {
                // Bottom
                dy = Math.max(-(this.region.height - 1), Math.min(stored_level.size_y - this.region.bottom, dy));
                this.resize_y = dy;
                this.offset_y = 0;
            }
        }

        this.target.setAttribute('x', this.region.x + this.offset_x);
        this.target.setAttribute('y', this.region.y + this.offset_y);
        this.target.setAttribute('width', this.region.width + this.resize_x);
        this.target.setAttribute('height', this.region.height + this.resize_y);
        this._update_size_text();
    }
    commit_press() {
        if (this.mode === 'create') {
            // Region is already updated, just add it to the level
            this.editor.stored_level.camera_regions.push(this.region);
        }
        else {
            // Actually edit the underlying region
            this.region.x += this.offset_x;
            this.region.y += this.offset_y;
            this.region.width += this.resize_x;
            this.region.height += this.resize_y;
        }
    }
    abort_press() {
        if (this.mode === 'create') {
            // The element was fake, so delete it
            this.target.remove();
        }
        else {
            // Move the element back to its original location
            this.target.setAttribute('x', this.region.x);
            this.target.setAttribute('y', this.region.y);
            this.target.setAttribute('width', this.region.width);
            this.target.setAttribute('height', this.region.height);
        }
    }
    cleanup_press() {
        this.editor.viewport_el.style.cursor = '';
        this.size_text.remove();
    }
}

class CameraEraseOperation extends MouseOperation {
    handle_press(x, y, ev) {
        let target = ev.target.closest('.overlay-camera');
        if (target) {
            let index = parseInt(target.getAttribute('data-region-index'), 10);
            target.remove();
            this.editor.stored_level.camera_regions.splice(index, 1);
        }
    }
}

const EDITOR_TOOLS = {
    pencil: {
        icon: 'icons/tool-pencil.png',
        name: "Pencil",
        desc: "Place, erase, and select tiles.\nLeft click: draw\nCtrl: erase\nShift: replace all layers\nRight click: pick foreground tile\nCtrl-right click: pick background tile",
        uses_palette: true,
        op1: PencilOperation,
        op2: EyedropOperation,
        shortcut: 'b',
    },
    line: {
        // TODO not implemented
        icon: 'icons/tool-line.png',
        name: "Line",
        desc: "Draw straight lines",
        uses_palette: true,
        shortcut: 'l',
    },
    box: {
        // TODO not implemented
        icon: 'icons/tool-box.png',
        name: "Box",
        desc: "Fill a rectangular area with tiles",
        uses_palette: true,
        shortcut: 'u',
    },
    fill: {
        icon: 'icons/tool-fill.png',
        name: "Fill",
        desc: "Flood-fill an area with tiles",
        uses_palette: true,
        op1: FillOperation,
        op2: EyedropOperation,
        shortcut: 'g',
    },
    select_box: {
        icon: 'icons/tool-select-box.png',
        name: "Box select",
        desc: "Select and manipulate rectangles.",
        affects_selection: true,
        op1: SelectOperation,
        shortcut: 'm',
    },
    'force-floors': {
        icon: 'icons/tool-force-floors.png',
        name: "Force floors",
        desc: "Draw force floors following the cursor.",
        op1: ForceFloorOperation,
    },
    tracks: {
        icon: 'icons/tool-tracks.png',
        name: "Tracks",
        desc: "Draw tracks following the cursor.\nLeft click: Lay tracks\nCtrl-click: Erase tracks\nRight click: Toggle track switch",
        op1: TrackOperation,
        op2: TrackOperation,
    },
    adjust: {
        icon: 'icons/tool-adjust.png',
        name: "Adjust",
        desc: "Edit existing tiles.\nLeft click: rotate actor or toggle terrain\nRight click: rotate or toggle in reverse\nShift: always target terrain\nCtrl-click: edit properties of complex tiles\n(wires, railroads, hints, etc.)",
        op1: AdjustOperation,
        op2: AdjustOperation,
        shortcut: 'a',
    },
    connect: {
        icon: 'icons/tool-connect.png',
        name: "Connect",
        // XXX shouldn't you be able to drag the destination?
        // TODO mod + right click for RRO or diamond alg?  ah but we only have ctrl available
        desc: "Set up CC1-style clone and trap connections.\n(WIP)\nNOTE: Not supported in CC2!\nRight click: auto link using Lynx rules",
        //desc: "Set up CC1-style clone and trap connections.\nNOTE: Not supported in CC2!\nLeft drag: link button with valid target\nCtrl-click: erase link\nRight click: auto link using Lynx rules",
        op1: ConnectOperation,
        op2: ConnectOperation,
    },
    wire: {
        icon: 'icons/tool-wire.png',
        name: "Wire",
        desc: "Edit CC2 wiring.\nLeft click: draw wires\nCtrl-click: erase wires\nRight click: toggle tunnels (floor only)",
        op1: WireOperation,
        op2: WireOperation,
    },
    camera: {
        icon: 'icons/tool-camera.png',
        name: "Camera",
        desc: "Draw and edit custom camera regions",
        help: "Draw and edit camera regions.\n(LL only.  When the player is within a camera region,\nthe camera stays locked inside it.)\nLeft click: create or edit a region\nRight click: erase a region",
        op1: CameraOperation,
        op2: CameraEraseOperation,
    },
    // TODO text tool; thin walls tool; ice tool; map generator?; subtools for select tool (copy, paste, crop)
    // TODO interesting option: rotate an actor as you draw it by dragging?  or hold a key like in
    // slade when you have some selected?
    // TODO ah, railroads...
};
const EDITOR_TOOL_ORDER = ['pencil', 'select_box', 'fill', 'adjust', 'force-floors', 'tracks', 'connect', 'wire', 'camera'];
const EDITOR_TOOL_SHORTCUTS = {};
for (let [tool, tooldef] of Object.entries(EDITOR_TOOLS)) {
    if (tooldef.shortcut) {
        EDITOR_TOOL_SHORTCUTS[tooldef.shortcut] = tool;
    }
}

// TODO this MUST use a LL tileset!
const EDITOR_PALETTE = [{
    title: "Basics",
    tiles: [
        'player', 'player2', 'hint',
        'floor', 'wall', 'thin_walls/south',
        'chip', 'chip_extra', 'socket', 'exit',
    ],
}, {
    title: "Terrain",
    tiles: [
        'popwall',
        'steel',
        'wall_invisible',
        'wall_appearing',
        'fake_floor',
        'fake_wall',
        'popdown_floor',
        'popdown_wall',

        'floor_letter',
        'gravel',
        'dirt',
        'slime',
        'thief_keys',
        'thief_tools',
        'no_player1_sign',
        'no_player2_sign',

        'floor_custom_green', 'floor_custom_pink', 'floor_custom_yellow', 'floor_custom_blue',
        'wall_custom_green', 'wall_custom_pink', 'wall_custom_yellow', 'wall_custom_blue',

        'door_blue', 'door_red', 'door_yellow', 'door_green',
        'swivel_nw',
        'railroad/straight',
        'railroad/curve',
        'railroad/switch',

        'water', 'turtle', 'fire',
        'ice', 'ice_nw',
        'force_floor_s', 'force_floor_all',
        'canopy',
    ],
}, {
    title: "Items",
    tiles: [
        'key_blue', 'key_red', 'key_yellow', 'key_green',
        'flippers', 'fire_boots', 'cleats', 'suction_boots',
        'hiking_boots', 'speed_boots', 'lightning_bolt', 'railroad_sign',
        'helmet', 'foil', 'hook', 'xray_eye',
        'bribe', 'bowling_ball', 'dynamite', 'no_sign',
        'score_10', 'score_100', 'score_1000', 'score_2x',
    ],
}, {
    title: "Creatures",
    tiles: [
        'tank_blue',
        'tank_yellow',
        'ball',
        'walker',
        'fireball',
        'glider',
        'bug',
        'paramecium',

        'doppelganger1',
        'doppelganger2',
        'teeth',
        'teeth_timid',
        'floor_mimic',
        'ghost',
        'rover',
        'blob',
    ],
}, {
    title: "Mechanisms",
    tiles: [
        'dirt_block',
        'ice_block',
        'frame_block/0',
        'frame_block/1',
        'frame_block/2a',
        'frame_block/2o',
        'frame_block/3',
        'frame_block/4',

        'green_floor',
        'green_wall',
        'green_chip',
        'green_bomb',
        'button_green',
        'button_blue',
        'button_yellow',
        'bomb',

        'button_red', 'cloner',
        'button_brown', 'trap',
        'button_orange', 'flame_jet_off', 'flame_jet_on',
        'transmogrifier',

        'teleport_blue',
        'teleport_red',
        'teleport_green',
        'teleport_yellow',
        'stopwatch_bonus',
        'stopwatch_penalty',
        'stopwatch_toggle',
    ],
    // TODO missing:
    // - wires, wire tunnels        probably a dedicated tool, placing tunnels like a tile makes no sense
    // - canopy                     normal tile; layering problem
    // - thin walls                 special rotate logic, like force floors; layering problem
    // TODO should tiles that respond to wiring and/or gray buttons be highlighted, highlightable?
}, {
    title: "Logic",
    tiles: [
        'logic_gate/not',
        'logic_gate/and',
        'logic_gate/or',
        'logic_gate/xor',
        'logic_gate/nand',
        'logic_gate/latch-cw',
        'logic_gate/latch-ccw',
        'logic_gate/counter',
        'button_pink',
        'button_black',
        'light_switch_off',
        'light_switch_on',
        'purple_floor',
        'purple_wall',
        'button_gray',
    ],
}, {
    title: "Experimental",
    tiles: [
        'circuit_block/xxx',
        'gift_bow',
        'skeleton_key',
        'gate_red',
        'gate_blue',
        'gate_yellow',
        'gate_green',
        'sand',
        'dash_floor',
        'spikes',
        'cracked_ice',
        'hole',
        'cracked_floor',
        'turntable_cw',
        'turntable_ccw',
        'teleport_blue_exit',
        'electrified_floor',
        'ankh',
        'score_5x',
        'boulder',
        'glass_block',
        'logic_gate/diode',
        'sokoban_block/red',
        'sokoban_button/red',
        'sokoban_wall/red',
        'sokoban_block/blue',
        'sokoban_button/blue',
        'sokoban_wall/blue',
        'sokoban_block/green',
        'sokoban_button/green',
        'sokoban_wall/green',
        'sokoban_block/yellow',
        'sokoban_button/yellow',
        'sokoban_wall/yellow',
        'one_way_walls/south',
    ],
}];

// TODO loading this from json might actually be faster
const EDITOR_TILE_DESCRIPTIONS = {
    // Basics
    player: {
        name: "Lexy",
        cc2_name: "Chip",
        desc: "The player, a fox girl who enjoys puzzles.  Slides on ice.  Can walk on dirt and gravel.  Reuses green keys.",
    },
    player2: {
        name: "Cerise",
        cc2_name: "Melinda",
        desc: "The player, a gel rabbat who enjoys Lexy.  Walks on ice.  Stopped by dirt and gravel.  Reuses yellow keys.",
    },
    hint: {
        name: "Hint",
        desc: "Shows a hint or message of the level designer's choosing.  Stops dirt blocks and monsters.",
    },
    floor: {
        name: "Floor",
        desc: "Plain floor.  No effect.  May contain wires; conducts power in all directions, except that two crossed wires are independent.  May contain wire tunnels, which conduct power across long distances.",
    },
    wall: {
        name: "Wall",
        desc: "Plain wall.  Stops almost everything.",
    },
    thin_walls: {
        name: "Thin wall",
        desc: "Similar to a wall, but squeezed into the edges.",
    },
    chip: {
        name: "Heart",
        cc2_name: "Chip",
        desc: "Goal of most levels.  Must be collected to open the heart socket.  Stops dirt blocks and most monsters, except rovers.",
    },
    chip_extra: {
        name: "Extra heart",
        cc2_name: "Extra chip",
        desc: "Appears and acts like a heart, but doesn't contribute to the level's required heart count.",
    },
    socket: {
        name: "Socket",
        desc: "Can only be opened when the required number of hearts has been collected.  Stops dirt blocks and most monsters, except rovers, but can be opened by anything else.  Not affected by ghosts.",
    },
    exit: {
        name: "Exit",
        desc: "All players must step on one to clear the level.  Stops dirt blocks and most monsters, except rovers.",
    },

    // Terrain
    popwall: {
        name: "Popwall",
        desc: "Turns into a wall when something steps off of it.  Stops dirt blocks and monsters.",
    },
    steel: {
        name: "Steel wall",
        desc: "Stops everything, even ghosts.  May contain wires; conducts power the same way as floor.",
    },
    wall_invisible: {
        name: "Invisible wall",
        desc: "Reveals briefly when bumped, then disappears again.",
    },
    wall_appearing: {
        name: "Reveal wall",
        desc: "Turns into a normal wall when bumped.",
    },
    fake_floor: {
        name: "Illusory floor",
        desc: "Looks like an illusory wall, but turns to floor when bumped.  Stops dirt blocks and monsters.",
    },
    fake_wall: {
        name: "Illusory wall",
        desc: "Turns to wall when bumped.",
    },
    popdown_floor: {
        name: "Popdown floor",
        desc: "Presses down into floor while something's on it.  Stops all blocks.",
    },
    popdown_wall: {
        name: "Fake popdown floor",
        desc: "Looks like a popdown floor, but acts like a normal wall.",
    },
    floor_letter: {
        name: "Letter tile",
        desc: "Acts like a normal floor.  May contain a single letter, number, arrow, or symbol.",
    },
    gravel: {
        name: "Gravel",
        desc: "Stops monsters.  Stops Cerise (and Doppel-Cerise) unless she has hiking boots.",
    },
    dirt: {
        name: "Dirt",
        desc: "Stops monsters.  Stops Cerise (and Doppel-Cerise) unless she has hiking boots.  Turns to floor when stepped on.",
    },
    slime: {
        name: "Slime",
        desc: "Destroys almost everything.  Blobs are unaffected and spread it to neighboring floor.  Cleared by blocks (except frame blocks, which are destroyed) without harming the block.",
    },
    thief_keys: {
        name: "Key thief",
        desc: "Steals all colored keys from a player that steps on it, and cuts bonus points in half.  Prefers to take a bribe, and will take one from anything.",
    },
    thief_tools: {
        name: "Tool thief",
        desc: "Steals all boots and other tools from a player that steps on it, and cuts bonus points in half.  Prefers to take a bribe, and will take one from anything.",
    },
    no_player1_sign: {
        name: "'No foxes' sign",
        desc: "Stops Lexy (and Doppel-Lexy).  No other effect.",
    },
    no_player2_sign: {
        name: "'No bunnies' sign",
        desc: "Stops Cerise (and Doppel-Cerise).  No other effect.",
    },
    floor_custom_green: {
        name: "Custom floor",
        desc: "Decorative.  Acts like normal floor, but stops ghosts.",
    },
    floor_custom_red: {
        name: "Custom floor",
        desc: "Decorative.  Acts like normal floor, but stops ghosts.",
    },
    floor_custom_yellow: {
        name: "Custom floor",
        desc: "Decorative.  Acts like normal floor, but stops ghosts.",
    },
    floor_custom_blue: {
        name: "Custom floor",
        desc: "Decorative.  Acts like normal floor, but stops ghosts.",
    },
    wall_custom_green: {
        name: "Custom wall",
        desc: "Decorative.  Acts like normal wall, but stops ghosts.",
    },
    wall_custom_red: {
        name: "Custom wall",
        desc: "Decorative.  Acts like normal wall, but stops ghosts.",
    },
    wall_custom_yellow: {
        name: "Custom wall",
        desc: "Decorative.  Acts like normal wall, but stops ghosts.",
    },
    wall_custom_blue: {
        name: "Custom wall",
        desc: "Decorative.  Acts like normal wall, but stops ghosts.",
    },
    door_blue: {
        name: "Blue door",
        desc: "Requires a blue key.  Turns to floor when opened.  Stops dirt blocks and monsters that don't normally collect items, even if they have a key.",
    },
    door_red: {
        name: "Red door",
        desc: "Requires a red key.  Turns to floor when opened.  Stops dirt blocks and monsters that don't normally collect items, even if they have a key.",
    },
    door_yellow: {
        name: "Yellow door",
        desc: "Requires a yellow key.  Turns to floor when opened.  Stops dirt blocks and monsters that don't normally collect items, even if they have a key.",
    },
    door_green: {
        name: "Green door",
        desc: "Requires a green key.  Turns to floor when opened.  Stops dirt blocks and monsters that don't normally collect items, even if they have a key.",
    },
    swivel_nw: {
        name: "Swivel door",
        desc: "Cannot be entered from the barred sides.  Rotates when something leaves through a barred side.",
    },
    railroad: {
        name: "Railroad track",
        desc: "Anything on it may move at its leisure, but only in legal directions along the track, unless it has a railroad crossing sign.  Only blocks may go back the way they came.  Attempts to move in illegal directions will be redirected.  May contain multiple track pieces, allowing a choice of which way to go.  With a track switch, only one track piece may be used at a time, and the active piece will change every time something leaves the track.  If connected to wire, the track will instead only switch when receiving a pulse.  Gray buttons can switch the track either way.",
    },
    water: {
        name: "Water",
        desc: "Drowns players and most monsters, unless they have a mermaid tail.  Turns dirt blocks into dirt, ice blocks into ice, and frame blocks into floor.  Gliders may pass freely.  Stops ghosts, unless they have a mermaid tail.",
    },
    turtle: {
        name: "Lilypad",
        cc2_name: "Turtle",
        desc: "May be passed safely, but turns to water when something steps off of it.  Stops ghosts.",
    },
    fire: {
        name: "Fire",
        desc: "Destroys players, unless they have fire boots.  Stops most monsters, even with fire boots.  No effect on fireballs.  Erased by ghosts with fire boots.  Turns ice blocks to water.",
    },
    ice: {
        name: "Ice",
        desc: "Causes anything that steps on it to slide uncontrollably, unless it has ice cleats.  Anything that hits an obstacle while on ice will turn around and slide back the other way.  No effect on Cerise (or Doppel-Cerise).",
    },
    ice_nw: {
        name: "Ice corner",
        desc: "Acts like ice, but turns anything sliding on it around the corner.  Edges act like thin walls.",
    },
    force_floor_n: {
        name: "Force floor",
        desc: "Slides anything on it in the indicated direction, unless it has suction boots.  Players may attempt to step off, but not on their first slide.  No effect on ghosts.",
    },
    force_floor_all: {
        name: "All-way force floor",
        desc: "Acts like force floor, but cycles clockwise through directions.  This cycle is shared between every all-way force floor in the level.",
    },
    canopy: {
        name: "Canopy",
        desc: "Hides everything beneath it from view, unless the player has the x-ray glasses.  Stops beetles and rovers.  Blobs under a canopy may not move to an adjacent canopy.",
    },

    // Items
    key_blue: {
        name: "Blue key",
        desc: "Opens blue locks.  Picked up by monsters and dirt blocks.",
    },
    key_red: {
        name: "Red key",
        desc: "Opens red locks.  Never picked up by anything besides a player.",
    },
    key_yellow: {
        name: "Yellow key",
        desc: "Opens yellow locks.  Stops dirt blocks and monsters (except rovers).",
    },
    key_green: {
        name: "Green key",
        desc: "Opens green locks.  Stops dirt blocks and monsters (except rovers).",
    },
    flippers: {
        name: "Mermaid tail",
        cc2_name: "Flippers",
        desc: "Allows safe passage through water.",
    },
    fire_boots: {
        name: "Fire boots",
        desc: "Allows safe passage through fire.",
    },
    cleats: {
        name: "Ice cleats",
        desc: "Allows walking normally on ice.",
    },
    suction_boots: {
        name: "Suction boots",
        desc: "Allows walking normally on force floors.",
    },
    hiking_boots: {
        name: "Hiking boots",
        desc: "Allows Cerise to walk on gravel and dirt.  Causes ghosts to turn dirt to floor.  No effect for other monsters.",
    },
    speed_boots: {
        name: "Speed boots",
        desc: "Causes the owner to move at double speed.",
    },
    lightning_bolt: {
        name: "Lightning boots",
        desc: "Powers any wires the owner is standing on.",
    },
    railroad_sign: {
        name: "RR crossing sign",
        desc: "Allows free movement on railroad tracks.",
    },
    helmet: {
        name: "Helmet",
        desc: "Prevents monsters or sliding blocks from hitting a player, or a player from walking into a monster.",
    },
    foil: {
        name: "Steel foil",
        desc: "Causes the owner to turn walls into steel walls when bumping them.",
    },
    hook: {
        name: "Hook",
        desc: "Causes the owner to pull blocks when moving directly away from them.",
    },
    xray_eye: {
        name: "X-ray glasses",
        cc2_name: "Secret eye",
        desc: "Reveals invisible walls, reveal walls, fake floors, popdown floors, floor mimics, and anything underneath dirt blocks, ice blocks, or canopies to the player.  No effect for anything else.",
    },
    bribe: {
        name: "Bribe",
        desc: "Stolen by thieves instead of anything else.",
    },
    bowling_ball: {
        name: "Bowling ball",
        desc: "When dropped, rolls in a straight line until it hits something.  Destroys objects it hits.  Picks up items it encounters.",
    },
    dynamite: {
        name: "Time bomb",
        cc2_name: "Dynamite",
        desc: "Can only be lit by a player.  A few seconds after being dropped, destroys everything in a 5×5 circle around it.  Canopies protect anything underneath; objects protect the floor they're on (including objects on a clone machine); steel walls, sockets, and logic gates cannot be destroyed; anything else becomes fire.",
    },
    no_sign: {
        name: "'No' sign",
        desc: "When placed over an item, stops anything holding that item.  When empty, has no effect, but an item may be dropped beneath it.",
    },
    score_10: {
        name: "+10 bonus",
        desc: "Grants the player 10 bonus points.  Can be collected by doppelgangers, rovers, and bowling balls, but will not grant bonus points.",
    },
    score_100: {
        name: "+100 bonus",
        desc: "Grants the player 100 bonus points.  Can be collected by doppelgangers, rovers, and bowling balls, but will not grant bonus points.",
    },
    score_1000: {
        name: "+1000 bonus",
        desc: "Grants the player 1000 bonus points.  Can be collected by doppelgangers, rovers, and bowling balls, but will not grant bonus points.",
    },
    score_2x: {
        name: "×2 bonus",
        desc: "Doubles the player's current bonus points.  Can be collected by doppelgangers, rovers, and bowling balls, but will not grant bonus points.",
    },

    // Creatures
    tank_blue: {
        name: "Blue tank",
        desc: "Only moves forwards.  Reverses direction when a blue button is pressed.",
    },
    tank_yellow: {
        name: "Yellow tank",
        desc: "Idles.  Moves one step in the corresponding direction when a yellow d-pad is pressed.",
    },
    ball: {
        name: "Bouncy ball",
        desc: "Turns around when it hits something.",
    },
    walker: {
        name: "Walker",
        desc: "Turns in a random direction when it hits something.",
    },
    fireball: {
        name: "Fireball",
        cc2_name: "Fire box",
        desc: "Turns right when it hits something.  Can safely pass through fire and flame jets.  Melts ice blocks.",
    },
    glider: {
        name: "Glider",
        cc2_name: "Ship",
        desc: "Turns left when it hits something.  Can safely cross water.",
    },
    bug: {
        name: "Beetle",
        cc2_name: "Ant",
        desc: "Follows the left wall.",
    },
    paramecium: {
        name: "Millipede",
        cc2_name: "Centipede",
        desc: "Follows the right wall.",
    },
    doppelganger1: {
        name: "Doppel-Lexy",
        cc2_name: "Mirror Chip",
        desc: "Copies Lexy's movements.  Does almost anything Lexy can do: collect items, push blocks, pass through tiles that block monsters, etc.  Cannot collect hearts.",
    },
    doppelganger2: {
        name: "Doppel-Cerise",
        cc2_name: "Mirror Melinda",
        desc: "Copies Cerise's movements.  Does almost anything Cerise can do: collect items, push blocks, walk normally on ice, pass through tiles that block monsters (but not dirt or gravel), etc.  Cannot collect hearts.",
    },
    teeth: {
        name: "Red chomper",
        cc2_name: "Angry teeth",
        desc: "Chases after Lexy.  Runs away from Cerise.  Pauses after each step.",
    },
    teeth_timid: {
        name: "Blue chomper",
        cc2_name: "Timid teeth",
        desc: "Chases after Cerise.  Runs away from Lexy.  Pauses after each step.",
    },
    floor_mimic: {
        name: "Floor mimic",
        desc: "Looks just like floor, except when moving.  Chases after the player.  Pauses after each step.",
    },
    ghost: {
        name: "Ghost",
        desc: "Turns left when it hits something.  Passes freely through almost all obstacles except blocks and other monsters, steel walls, water, lilypads, and custom floors/walls.  Does not set off mines.  Collects items and opens doors.  With fire boots, erases fire it steps on.  With flippers, can pass through water, but not lilypads.  Can only be destroyed by flame jets, bowling balls, and dynamite.",
    },
    rover: {
        name: "Rover",
        desc: "Cycles through the behavior of other monsters.  Collects items and pushes blocks.  Moves at half speed.",
    },
    blob: {
        name: "Blob",
        desc: "Moves in a random direction with every step.  Moves at half speed.",
    },

    // Mechanisms
    dirt_block: {
        name: "Dirt block",
        desc: "Can be pushed, but only one at a time.  Resists fire.  Turns to dirt in water.",
    },
    ice_block: {
        name: "Ice block",
        desc: "Can be pushed.  Pushes any ice block or frame block ahead of it.  Turns to water in fire.  Turns to ice in water.",
    },
    frame_block: {
        name: "Frame block",
        desc: "Can be pushed, but only in the directions given by the arrows.  Pushes any other kind of block ahead of it.  Can be moved in other directions by ice, force floors, etc.  Rotates when moved along a curved railroad track.",
    },
    green_floor: {
        name: "Toggle floor",
        desc: "Acts like a normal floor.  Becomes toggle wall when a green button is pressed.",
    },
    green_wall: {
        name: "Toggle wall",
        desc: "Acts like a normal wall.  Becomes toggle floor when a green button is pressed.",
    },
    green_chip: {
        name: "Toggle heart",
        cc2_name: "Toggle chip",
        desc: "Acts like a normal heart.  Counts toward the level's required hearts.  Becomes a toggle mine when a green button is pressed.",
    },
    green_bomb: {
        name: "Toggle mine",
        cc2_name: "Toggle bomb",
        desc: "Acts like a normal mine.  Counts toward the level's required hearts.  Becomes a toggle heart when a green button is pressed.",
    },
    button_green: {
        name: "Green button",
        desc: "Exchanges toggle floors with toggle walls, and toggle hearts with toggle mines.",
    },
    button_blue: {
        name: "Blue button",
        desc: "Reverses the direction of blue tanks.",
    },
    button_yellow: {
        name: "Yellow d-pad",
        cc2_name: "Yellow button",
        desc: "Moves yellow tanks one step in the direction it was stepped on.",
    },
    bomb: {
        name: "Mine",
        cc2_name: "Red bomb",
        desc: "Detonates and destroys anything that steps on it.",
    },
    button_red: {
        name: "Red button",
        desc: "Activates the nearest clone machine, searching left to right, top to bottom.",
    },
    cloner: {
        name: "Clone machine",
        desc: "When activated, creates a duplicate of whatever's on it.  Activated by a red button or a wire pulse.  If activated by wire and something's in the way, tries cloning in other directions.  When empty, can be populated by blocks (except dirt blocks), doppelgängers, ghosts, or rolling bowling balls.",
    },
    button_brown: {
        name: "Brown button",
        desc: "Opens the nearest trap while held down, searching left to right, top to bottom.  Anything freed is immediately spat out in the direction it's facing.",
    },
    trap: {
        name: "Trap",
        desc: "Prevents anything from leaving unless held open.  May be held open by a brown button or wire current.  Trapped monsters cannot turn, but a trapped player can.",
    },
    button_orange: {
        name: "Orange button",
        desc: "Toggles the state of the nearest flame jet while held down, searching outwards in a diamond pattern.",
    },
    flame_jet_off: {
        name: "Flame jet (off)",
        desc: "No effect.  Turned on while a linked orange button is held.  Toggled permanently by a pulse or a gray button.",
    },
    flame_jet_on: {
        name: "Flame jet (on)",
        desc: "Destroys almost anything that passes over it, except dirt blocks, fireballs, and anything wearing fire boots.  Turned off while a linked orange button is held.  Toggled permanently by a pulse or a gray button.",
    },
    transmogrifier: {
        name: "Transmogrifier",
        desc: "Changes most objects into corresponding opposites: Lexy ↔ Cerise, Doppel-Lexy ↔ Doppel-Cerise, dirt block ↔ ice block, bouncy ball ↔ walker, fireball → beetle → glider → millipede → fireball, blue tank ↔ yellow tank, red chomper ↔ blue chomper, blob → one of most monsters chosen at random.  If connected to wire, only functions while receiving power.",
    },
    teleport_blue: {
        name: "Blue teleporter",
        desc: "Teleports a traveller to the nearest available blue teleporter, searching right to left, bottom to top.  Only searches for exits in the direction the traveller entered.  If connected to wire, will only consider other teleporters on the same circuit (searching one-way through logic gates).  May contain wires; conducts power in all four directions.",
    },
    teleport_red: {
        name: "Red teleporter",
        desc: "Teleports a traveller to the nearest available red teleporter, searching left to right, top to bottom.  Searches for exits in any direction.  Allows players to exit in a direction of their choice.  If connected to wire, will only connect to other red teleporters while receiving power.  May contain wires, but does not conduct power.",
    },
    teleport_yellow: {
        name: "Yellow teleporter",
        desc: "Teleports a traveller to the nearest available yellow teleporter, searching right to left, bottom to top.  Only searches for exits in the direction the traveller entered.  Allows players to exit in a direction of their choice.  If no exit is available, will be picked up like an item, and can be dropped on any floor tile.",
    },
    teleport_green: {
        name: "Green teleporter",
        desc: "Teleports a traveller to a green teleporter chosen at random.  Chooses an available exit direction at random, but if the chosen destination has none, the teleport will fail.",
    },
    stopwatch_bonus: {
        name: "Time bonus",
        desc: "Adds ten seconds to the clock.  An untimed level becomes timed, with ten seconds remaining.",
    },
    stopwatch_penalty: {
        name: "Time penalty",
        desc: "Subtracts ten seconds from the clock.  If less than ten seconds remain, the clock will be reduced to its minimum, and the player will fail immediately if the clock is not paused.  An untimed level becomes timed and fails immediately.",
    },
    stopwatch_toggle: {
        name: "Stopwatch",
        desc: "Pauses or unpauses the clock.  No effect on untimed levels.",
    },

    // Logic
    'logic_gate/not': {
        name: "NOT gate",
        desc: "Emits power only when not receiving power.",
    },
    'logic_gate/diode': {
        name: "Diode",
        desc: "Emits power only when receiving power. (Effectively, this delays power by one frame.)",
    },
    'logic_gate/and': {
        name: "AND gate",
        desc: "Emits power while both inputs are receiving power.",
    },
    'logic_gate/or': {
        name: "OR gate",
        desc: "Emits power while at least one input is receiving power.",
    },
    'logic_gate/xor': {
        name: "XOR gate",
        desc: "Emits power while exactly one input is receiving power.",
    },
    'logic_gate/nand': {
        name: "NAND gate",
        desc: "Emits power while fewer than two inputs are receiving power.",
    },
    'logic_gate/latch-cw': {
        name: "Latch (clockwise)",
        desc: "Remembers its input and produces output to match.  Input is remembered while the chevron input is receiving power, ignored otherwise.",
    },
    'logic_gate/latch-ccw': {
        name: "Latch (counter clockwise)",
        desc: "Remembers its input and produces output to match.  Input is remembered while the chevron input is receiving power, ignored otherwise.",
    },
    'logic_gate/counter': {
        name: "Counter",
        desc: "Remembers and displays a single decimal digit.  Counts up by 1 when it receives a pulse on its right edge; if it wraps around to 0, emits a brief pulse out its left edge.  Counts down by 1 when it receives a pulse on its bottom edge; if it wraps around to 9, emits power from its top edge until it next receives power on its right or bottom edge.  Cannot be rotated.",
    },
    button_pink: {
        name: "Pink button",
        desc: "Emits power while held down.  May contain wires, but does not conduct power.",
    },
    button_black: {
        name: "Black button",
        desc: "Emits power while not held down.  May contain wires; conducts power separately along horizontal and vertical wires.",
    },
    light_switch_off: {
        name: "Light switch (off)",
        desc: "No effect.  Turns on when stepped on.  May contain wires.",
    },
    light_switch_on: {
        name: "Light switch (on)",
        desc: "Emits power.  Turns off when stepped on.  May contain wires.",
    },
    purple_floor: {
        name: "Switch floor",
        desc: "Acts like a normal floor.  Becomes switch wall while receiving power, or permanently when affected by a gray button.",
    },
    purple_wall: {
        name: "Switch wall",
        desc: "Acts like a normal wall.  Becomes switch floor while receiving power, or permanently when affected by a gray button.",
    },
    button_gray: {
        name: "Gray button",
        desc: "Permanently toggles the state of tiles in a surrounding 5×5 square.  Rotates swivels clockwise; switches railroad tracks; flips force floors; exchanges toggle walls/floors (but not hearts/mines); exchanges switch walls/floors; activates cloners as if by a red button; and toggles flame jets.",
    },

    // Experimental
    circuit_block: {
        name: "Circuit block",
        desc: "May contain wires, which will connect to any adjacent wires and conduct power as normal. When pushed into water, turns into floor with the same wires.",
    },
    gift_bow: {
        name: "Gift bow",
        desc: "When placed atop an item, anything may step on the item and will pick it up, even if it normally could not do so.  When placed alone, has no effect, but an item may be dropped beneath it.",
    },
    skeleton_key: {
        name: "Skeleton key",
        desc: "Counts as a tool, not a key.  Opens any color lock if the owner lacks a matching key.",
    },
    gate_red: {
        name: "Red gate",
        desc: "Requires a red key.  Unlike doors, may be placed on top of other terrain.",
    },
    sand: {
        name: "Sand",
        desc: "Anything walking on it moves at half speed.  Stops all blocks.",
    },
    ankh: {
        name: "Ankh",
        desc: "When dropped on empty floor by a player, inscribes a sacred symbol which will save a player's life once.",
    },
    turntable_cw: {
        name: "Turntable (clockwise)",
        desc: "Rotates anything entering this tile clockwise. Frame blocks are rotated too. If connected to wire, only functions while receiving power.",
    },
    turntable_ccw: {
        name: "Turntable (counterclockwise)",
        desc: "Rotates anything entering this tile counterclockwise. Frame blocks are rotated too. If connected to wire, only functions while receiving power.",
    },
    electrified_floor: {
        name: "Electrified floor",
        desc: "Conducts power (like a 4-way wire). While powered, destroys anything not wearing lightning boots (except dirt blocks).",
    },
    hole: {
        name: "Hole",
        desc: "A bottomless pit. Destroys everything (except ghosts).",
    },
    cracked_floor: {
        name: "Cracked floor",
        desc: "Turns into a hole when something steps off of it (except ghosts).",
    },
    cracked_ice: {
        name: "Cracked ice",
        desc: "Turns into water when something steps off of it (except ghosts).",
    },
    score_5x: {
        name: "×5 bonus",
        desc: "Quintuples the player's current bonus points.  Can be collected by doppelgangers, rovers, and bowling balls, but will not grant bonus points.",
    },
    spikes: {
        name: "Spikes",
        desc: "Stops players (and doppelgangers) unless they have hiking boots. Everything else can pass.",
    },
    boulder: {
        name: "Boulder",
        desc: "Similar to a dirt block, but rolls when pushed. Boulders transfer momentum to each other. Has ice block/frame block collision. Turns into gravel in water. Spreads slime.",
    },
    dash_floor: {
        name: "Dash floor",
        desc: "Anything walking on it moves at double speed. Stacks with speed shoes!",
    },
    teleport_blue_exit: {
        name: "Blue teleporter exit",
        desc: "A blue teleporter for all intents and purposes except it can only be exited, not entered.",
    },
    glass_block: {
        name: "Glass block",
        desc: "Similar to a dirt block, but stores the first item it moves over, dropping it when destroyed and cloning it in a cloning machine. Has ice block/frame block collision. Turns into floor in water. Doesn't have dirt block immunities.",
    },
    sokoban_block: {
        name: "Sokoban block",
        desc: "Similar to a dirt block.  Turns to colored floor in water.  Can't pass over colored floor of a different color.  Has no effect on sokoban buttons of a different color.",
    },
    sokoban_button: {
        name: "Sokoban button",
        desc: "Changes sokoban walls of the same color to floor, but only while all buttons of the same color are held.  Not affected by sokoban blocks of a different color.",
    },
    sokoban_wall: {
        name: "Sokoban wall",
        desc: "Acts like wall.  Turns to floor while all sokoban buttons of the same color are pressed.",
    },
};

const SPECIAL_PALETTE_ENTRIES = {
    'thin_walls/south':     { name: 'thin_walls', edges: DIRECTIONS['south'].bit },
    'frame_block/0':  { name: 'frame_block', direction: 'south', arrows: new Set },
    'frame_block/1':  { name: 'frame_block', direction: 'north', arrows: new Set(['north']) },
    'frame_block/2a': { name: 'frame_block', direction: 'north', arrows: new Set(['north', 'east']) },
    'frame_block/2o': { name: 'frame_block', direction: 'south', arrows: new Set(['north', 'south']) },
    'frame_block/3':  { name: 'frame_block', direction: 'south', arrows: new Set(['north', 'east', 'south']) },
    'frame_block/4':  { name: 'frame_block', direction: 'south', arrows: new Set(['north', 'east', 'south', 'west']) },
    // FIXME need to handle entered_direction intelligently, but also allow setting it explicitly
    'railroad/straight':    { name: 'railroad', tracks: 1 << 5, track_switch: null, entered_direction: 'north' },
    'railroad/curve':       { name: 'railroad', tracks: 1 << 0, track_switch: null, entered_direction: 'north' },
    'railroad/switch':      { name: 'railroad', tracks: 0, track_switch: 0, entered_direction: 'north' },
    'logic_gate/not':       { name: 'logic_gate', direction: 'north', gate_type: 'not' },
    'logic_gate/diode':     { name: 'logic_gate', direction: 'north', gate_type: 'diode' },
    'logic_gate/and':       { name: 'logic_gate', direction: 'north', gate_type: 'and' },
    'logic_gate/or':        { name: 'logic_gate', direction: 'north', gate_type: 'or' },
    'logic_gate/xor':       { name: 'logic_gate', direction: 'north', gate_type: 'xor' },
    'logic_gate/nand':      { name: 'logic_gate', direction: 'north', gate_type: 'nand' },
    'logic_gate/latch-cw':  { name: 'logic_gate', direction: 'north', gate_type: 'latch-cw' },
    'logic_gate/latch-ccw': { name: 'logic_gate', direction: 'north', gate_type: 'latch-ccw' },
    'logic_gate/counter':   { name: 'logic_gate', direction: 'north', gate_type: 'counter', memory: 0 },
    'circuit_block/xxx':    { name: 'circuit_block', direction: 'south', wire_directions: 0xf },
    'sokoban_block/red':    { name: 'sokoban_block', color: 'red' },
    'sokoban_button/red':   { name: 'sokoban_button', color: 'red' },
    'sokoban_wall/red':     { name: 'sokoban_wall', color: 'red' },
    'sokoban_block/blue':   { name: 'sokoban_block', color: 'blue' },
    'sokoban_button/blue':  { name: 'sokoban_button', color: 'blue' },
    'sokoban_wall/blue':    { name: 'sokoban_wall', color: 'blue' },
    'sokoban_block/yellow': { name: 'sokoban_block', color: 'yellow' },
    'sokoban_button/yellow':{ name: 'sokoban_button', color: 'yellow' },
    'sokoban_wall/yellow':  { name: 'sokoban_wall', color: 'yellow' },
    'sokoban_block/green':  { name: 'sokoban_block', color: 'green' },
    'sokoban_button/green': { name: 'sokoban_button', color: 'green' },
    'sokoban_wall/green':   { name: 'sokoban_wall', color: 'green' },
    'one_way_walls/south':  { name: 'one_way_walls', edges: DIRECTIONS['south'].bit },
};
const _RAILROAD_ROTATED_LEFT = [3, 0, 1, 2, 5, 4];
const _RAILROAD_ROTATED_RIGHT = [1, 2, 3, 0, 5, 4];
const SPECIAL_PALETTE_BEHAVIOR = {
    floor_letter: {
        pick_palette_entry(tile) {
            return 'floor_letter';
        },
        _arrows: ["⬆", "➡", "⬇", "⬅"],
        rotate_left(tile) {
            // Rotate through arrows and ASCII separately
            let arrow_index = this._arrows.indexOf(tile.overlaid_glyph);
            if (arrow_index >= 0) {
                tile.overlaid_glyph = this._arrows[(arrow_index + 3) % 4];
                return;
            }

            let cp = tile.overlaid_glyph.charCodeAt(0);
            cp -= 1;
            if (cp < 32) {
                cp = 95;
            }
            tile.overlaid_glyph = String.fromCharCode(cp);
        },
        rotate_right(tile) {
            let arrow_index = this._arrows.indexOf(tile.overlaid_glyph);
            if (arrow_index >= 0) {
                tile.overlaid_glyph = this._arrows[(arrow_index + 1) % 4];
                return;
            }

            let cp = tile.overlaid_glyph.charCodeAt(0);
            cp += 1;
            if (cp > 95) {
                cp = 32;
            }
            tile.overlaid_glyph = String.fromCharCode(cp);
        },
    },
    thin_walls: {
        pick_palette_entry(tile) {
            return 'thin_walls/south';
        },
        rotate_left(tile) {
            if (tile.edges & 0x01) {
                tile.edges |= 0x10;
            }
            tile.edges >>= 1;
        },
        rotate_right(tile) {
            tile.edges <<= 1;
            if (tile.edges & 0x10) {
                tile.edges = (tile.edges & ~0x10) | 0x01;
            }
        },
        combine_draw(palette_tile, existing_tile) {
            existing_tile.edges |= palette_tile.edges;
        },
        combine_erase(palette_tile, existing_tile) {
            existing_tile.edges &= ~palette_tile.edges;
            if (existing_tile.edges === 0)
                return true;
        },
    },
    frame_block: {
        pick_palette_entry(tile) {
            if (tile.arrows.size === 2) {
                let [a, b] = tile.arrows.keys();
                if (a === DIRECTIONS[b].opposite) {
                    return 'frame_block/2o';
                }
                else {
                    return 'frame_block/2a';
                }
            }
            else {
                return `frame_block/${tile.arrows.size}`;
            }
        },
        rotate_left(tile) {
            tile.direction = DIRECTIONS[tile.direction].left;
            tile.arrows = new Set(Array.from(tile.arrows, arrow => DIRECTIONS[arrow].left));
        },
        rotate_right(tile) {
            tile.direction = DIRECTIONS[tile.direction].right;
            tile.arrows = new Set(Array.from(tile.arrows, arrow => DIRECTIONS[arrow].right));
        },
    },
    logic_gate: {
        pick_palette_entry(tile) {
            return `logic_gate/${tile.gate_type}`;
        },
        rotate_left(tile) {
            if (tile.gate_type === 'counter') {
                tile.memory = (tile.memory + 9) % 10;
            }
            else {
                tile.direction = DIRECTIONS[tile.direction].left;
            }
        },
        rotate_right(tile) {
            if (tile.gate_type === 'counter') {
                tile.memory = (tile.memory + 1) % 10;
            }
            else {
                tile.direction = DIRECTIONS[tile.direction].right;
            }
        },
    },
    railroad: {
        pick_palette_entry(tile) {
            // This is a little fuzzy, since railroads are compound, but we just go with the first
            // one that matches and fall back to the switch if it's empty
            if (tile.tracks & 0x30) {
                return 'railroad/straight';
            }
            if (tile.tracks) {
                return 'railroad/curve';
            }
            return 'railroad/switch';
        },
        rotate_left(tile) {
            let new_tracks = 0;
            for (let i = 0; i < 6; i++) {
                if (tile.tracks & (1 << i)) {
                    new_tracks |= 1 << _RAILROAD_ROTATED_LEFT[i];
                }
            }
            tile.tracks = new_tracks;

            if (tile.track_switch !== null) {
                tile.track_switch = _RAILROAD_ROTATED_LEFT[tile.track_switch];
            }

            if (tile.entered_direction) {
                tile.entered_direction = DIRECTIONS[tile.entered_direction].left;
            }
        },
        rotate_right(tile) {
            let new_tracks = 0;
            for (let i = 0; i < 6; i++) {
                if (tile.tracks & (1 << i)) {
                    new_tracks |= 1 << _RAILROAD_ROTATED_RIGHT[i];
                }
            }
            tile.tracks = new_tracks;

            if (tile.track_switch !== null) {
                tile.track_switch = _RAILROAD_ROTATED_RIGHT[tile.track_switch];
            }

            if (tile.entered_direction) {
                tile.entered_direction = DIRECTIONS[tile.entered_direction].right;
            }
        },
        combine_draw(palette_tile, existing_tile) {
            existing_tile.tracks |= palette_tile.tracks;
            // If we have a switch already, the just-placed track becomes the current one
            if (existing_tile.track_switch !== null) {
                for (let i = 0; i < 6; i++) {
                    if (palette_tile.tracks & (1 << i)) {
                        existing_tile.track_switch = i;
                        break;
                    }
                }
            }

            if (palette_tile.track_switch !== null && existing_tile.track_switch === null) {
                // The palette's switch is just an indication that we should have one, not what it
                // ought to be
                existing_tile.track_switch = palette_tile.track_switch;
                for (let i = 0; i < 6; i++) {
                    if (existing_tile.tracks & (1 << i)) {
                        existing_tile.track_switch = i;
                        break;
                    }
                }
            }
        },
        combine_erase(palette_tile, existing_tile) {
            existing_tile.tracks &= ~palette_tile.tracks;

            // If there are no track pieces left, remove the railroad.  It's technically possible to
            // have a railroad with no tracks, but you're very unlikely to want it, and if you
            // really do then you can do it yourself
            if (existing_tile.tracks === 0)
                return true;

            if (palette_tile.track_switch !== null) {
                existing_tile.track_switch = null;
            }

            // Fix the track switch if necessary
            if (existing_tile.track_switch !== null) {
                let num_tracks = 0;
                for (let i = 0; i < 6; i++) {
                    if (existing_tile.tracks & (1 << i)) {
                        num_tracks += 1;
                        if (! (existing_tile.tracks & (1 << existing_tile.track_switch))) {
                            existing_tile.track_switch = i;
                        }
                    }
                }

                // Remove the switch if there's nothing to switch
                if (num_tracks <= 1) {
                    existing_tile.track_switch = null;
                }
            }
        },
    },
    circuit_block: {
        pick_palette_entry(tile) {
            return 'circuit_block/xxx';
        },
    },
    sokoban_block: {
        pick_palette_entry(tile) {
            return 'sokoban_block/' + (tile.color ?? 'red');
        },
    },
    sokoban_button: {
        pick_palette_entry(tile) {
            return 'sokoban_button/' + (tile.color ?? 'red');
        },
    },
    sokoban_wall: {
        pick_palette_entry(tile) {
            return 'sokoban_wall/' + (tile.color ?? 'red');
        },
    },
    one_way_walls: {
        pick_palette_entry(tile) {
            return 'one_way_walls/south';
        },
    },
};
SPECIAL_PALETTE_BEHAVIOR['one_way_walls'] = {
    ...SPECIAL_PALETTE_BEHAVIOR['thin_walls'],
    ...SPECIAL_PALETTE_BEHAVIOR['one_way_walls'],
};
// Fill in some special behavior that boils down to rotating tiles which happen to be encoded as
// different tile types
for (let cycle of [
    ['force_floor_n', 'force_floor_e', 'force_floor_s', 'force_floor_w'],
    ['ice_nw', 'ice_ne', 'ice_se', 'ice_sw'],
    ['swivel_nw', 'swivel_ne', 'swivel_se', 'swivel_sw'],
    ['terraformer_n', 'terraformer_e', 'terraformer_s', 'terraformer_w'],
    ['turntable_cw', 'turntable_ccw'],
]) {
    for (let [i, name] of cycle.entries()) {
        let left = cycle[(i - 1 + cycle.length) % cycle.length];
        let right = cycle[(i + 1) % cycle.length];
        SPECIAL_PALETTE_BEHAVIOR[name] = {
            pick_palette_entry(tile) {
                return name;
            },
            rotate_left(tile) {
                tile.type = TILE_TYPES[left];
            },
            rotate_right(tile) {
                tile.type = TILE_TYPES[right];
            },
        };
    }
}

// TODO probably need to combine this with Selection somehow since it IS one, just not committed yet
class PendingSelection {
    constructor(owner) {
        this.owner = owner;
        this.element = mk_svg('rect.overlay-pending-selection');
        this.owner.svg_group.append(this.element);
        this.rect = null;
    }

    set_extrema(x0, y0, x1, y1) {
        this.rect = new DOMRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x0 - x1) + 1, Math.abs(y0 - y1) + 1);
        this.element.classList.add('--visible');
        this.element.setAttribute('x', this.rect.x);
        this.element.setAttribute('y', this.rect.y);
        this.element.setAttribute('width', this.rect.width);
        this.element.setAttribute('height', this.rect.height);
    }

    commit() {
        this.owner.set_from_rect(this.rect);
        this.element.remove();
    }

    discard() {
        this.element.remove();
    }
}

class Selection {
    constructor(editor) {
        this.editor = editor;

        this.svg_group = mk_svg('g');
        this.editor.svg_overlay.append(this.svg_group);

        this.rect = null;
        this.element = mk_svg('rect.overlay-selection.overlay-transient');
        this.svg_group.append(this.element);

        this.floated_cells = null;
        this.floated_element = null;
    }

    get is_empty() {
        return this.rect === null;
    }

    get is_floating() {
        return !! this.floated_cells;
    }

    contains(x, y) {
        // Empty selection means everything is selected?
        if (this.rect === null)
            return true;

        return this.rect.left <= x && x < this.rect.right && this.rect.top <= y && y < this.rect.bottom;
    }

    create_pending() {
        return new PendingSelection(this);
    }

    set_from_rect(rect) {
        let old_rect = this.rect;
        this.editor._do(
            () => this._set_from_rect(rect),
            () => {
                if (old_rect) {
                    this._set_from_rect(old_rect);
                }
                else {
                    this._clear();
                }
            },
            false,
        );
    }

    _set_from_rect(rect) {
        this.rect = rect;
        this.element.classList.add('--visible');
        this.element.setAttribute('x', this.rect.x);
        this.element.setAttribute('y', this.rect.y);
        this.element.setAttribute('width', this.rect.width);
        this.element.setAttribute('height', this.rect.height);
    }

    move_by(dx, dy) {
        if (! this.rect)
            return;

        this.rect.x += dx;
        this.rect.y += dy;
        this.element.setAttribute('x', this.rect.x);
        this.element.setAttribute('y', this.rect.y);

        if (! this.floated_element)
            return;

        let bbox = this.rect;
        this.floated_element.setAttribute('transform', `translate(${bbox.x} ${bbox.y})`);
    }

    clear() {
        let rect = this.rect;
        if (! rect)
            return;

        this.editor._do(
            () => this._clear(),
            () => this._set_from_rect(rect),
            false,
        );
    }

    _clear() {
        this.rect = null;
        this.element.classList.remove('--visible');
    }

    *iter_coords() {
        if (! this.rect)
            return;

        let stored_level = this.editor.stored_level;
        for (let x = this.rect.left; x < this.rect.right; x++) {
            for (let y = this.rect.top; y < this.rect.bottom; y++) {
                let n = stored_level.coords_to_scalar(x, y);
                yield [x, y, n];
            }
        }
    }

    // Convert this selection into a floating selection, plucking all the selected cells from the
    // level and replacing them with blank cells.
    enfloat(copy = false) {
        if (this.floated_cells)
            console.error("Trying to float a selection that's already floating");

        let floated_cells = [];
        let tileset = this.editor.renderer.tileset;
        let stored_level = this.editor.stored_level;
        let bbox = this.rect;
        let canvas = mk('canvas', {width: bbox.width * tileset.size_x, height: bbox.height * tileset.size_y});
        let ctx = canvas.getContext('2d');
        ctx.drawImage(
            this.editor.renderer.canvas,
            bbox.x * tileset.size_x, bbox.y * tileset.size_y, bbox.width * tileset.size_x, bbox.height * tileset.size_y,
            0, 0, bbox.width * tileset.size_x, bbox.height * tileset.size_y);
        for (let [x, y, n] of this.iter_coords()) {
            let cell = stored_level.linear_cells[n];
            if (copy) {
                floated_cells.push(cell.map(tile => tile ? {...tile} : null));
            }
            else {
                floated_cells.push(cell);
                this.editor.replace_cell(cell, this.editor.make_blank_cell(x, y));
            }
        }
        let floated_element = mk_svg('g', mk_svg('foreignObject', {
            x: 0, y: 0,
            width: canvas.width, height: canvas.height,
            transform: `scale(${1/tileset.size_x} ${1/tileset.size_y})`,
        }, canvas));
        floated_element.setAttribute('transform', `translate(${bbox.x} ${bbox.y})`);

        // FIXME far more memory efficient to recreate the canvas in the redo, rather than hold onto
        // it forever
        this.editor._do(
            () => {
                this.floated_element = floated_element;
                this.floated_cells = floated_cells;
                this.svg_group.append(floated_element);
            },
            () => this._defloat(),
        );
    }

    stamp_float(copy = false) {
        if (! this.floated_element)
            return;

        let bbox = this.rect;
        let stored_level = this.editor.stored_level;
        let i = 0;
        for (let [x, y, n] of this.iter_coords()) {
            let cell = this.floated_cells[i];
            if (copy) {
                cell = cell.map(tile => tile ? {...tile} : null);
            }
            cell.x = x;
            cell.y = y;
            this.editor.replace_cell(stored_level.linear_cells[n], cell);
            i += 1;
        }
    }

    defloat() {
        if (! this.floated_element)
            return;

        this.stamp_float();

        let element = this.floated_element;
        let cells = this.floated_cells;
        this.editor._do(
            () => this._defloat(),
            () => {
                this.floated_cells = cells;
                this.floated_element = element;
                this.svg_group.append(element);
            },
            false,
        );
    }

    _defloat() {
        this.floated_element.remove();
        this.floated_element = null;
        this.floated_cells = null;
    }

    // TODO allow floating/dragging, ctrl-dragging to copy, anchoring...
    // TODO make more stuff respect this (more things should go through Editor for undo reasons anyway)
}

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
const EDITOR_ZOOM_LEVELS = [0.0625, 0.125, 0.25, 0.5, 1, 2, 3, 4, 6, 8, 10, 12, 16];
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
        this.statusbar_zoom_input = mk('input', {type: 'range', min: 0, max: EDITOR_ZOOM_LEVELS.length - 1});
        this.statusbar_zoom_input.addEventListener('input', ev => {
            let index = parseInt(ev.target.value, 10);
            if (index < 0) {
                index = 0;
            }
            else if (index >= EDITOR_ZOOM_LEVELS.length) {
                index = EDITOR_ZOOM_LEVELS.length - 1;
            }
            // Center the zoom on the center of the viewport
            let rect = this.actual_viewport_el.getBoundingClientRect();
            this.set_canvas_zoom(
                EDITOR_ZOOM_LEVELS[index],
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
                    if (EDITOR_TOOLS[this.current_tool].affects_selection) {
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
                    if (EDITOR_TOOLS[this.current_tool].affects_selection) {
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
                else if (EDITOR_TOOL_SHORTCUTS[ev.key]) {
                    this.select_tool(EDITOR_TOOL_SHORTCUTS[ev.key]);
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
                op_type = EDITOR_TOOLS[this.current_tool].op1;
            }
            else if (button === 1) {
                // Middle button: always pan
                op_type = PanOperation;
                // TODO how should this impact the hover?
            }
            else if (button === 2) {
                // Right button: activate tool's alt mode
                op_type = EDITOR_TOOLS[this.current_tool].op2;
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
        this.actual_viewport_el.addEventListener('mouseleave', ev => {
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
        window.addEventListener('blur', ev => {
            this.cancel_mouse_drag();
        });
        window.addEventListener('mouseleave', ev => {
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

            let index = EDITOR_ZOOM_LEVELS.findIndex(el => el >= this.zoom);
            if (index < 0) {
                index = EDITOR_ZOOM_LEVELS.length - 1;
            }

            let new_zoom;
            if (ev.deltaY > 0) {
                // Zoom out
                if (EDITOR_ZOOM_LEVELS[index] !== this.zoom) {
                    // If we're between levels, pretend we're one level in
                    index++;
                }
                if (index <= 0)
                    return;
                new_zoom = EDITOR_ZOOM_LEVELS[index - 1];
            }
            else {
                // Zoom in
                if (EDITOR_ZOOM_LEVELS[index] !== this.zoom) {
                    index--;
                }
                if (index >= EDITOR_ZOOM_LEVELS.length - 1)
                    return;
                new_zoom = EDITOR_ZOOM_LEVELS[index + 1];
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
        this.fg_tile_el.addEventListener('click', ev => {
            if (this.fg_tile && TILES_WITH_PROPS[this.fg_tile.type.name]) {
                this.open_tile_prop_overlay(
                    this.fg_tile, null, this.fg_tile_el.getBoundingClientRect());
            }
        });
        this.bg_tile_el = this.renderer.draw_single_tile_type('floor');
        this.bg_tile_el.addEventListener('click', ev => {
            if (this.bg_tile && TILES_WITH_PROPS[this.bg_tile.type.name]) {
                this.open_tile_prop_overlay(
                    this.bg_tile, null, this.bg_tile_el.getBoundingClientRect());
            }
        });
        // TODO ones for the palette too??
        this.palette_rotation_index = 0;
        this.palette_actor_direction = 'south';
        let rotate_right_button = mk('button.--image', {type: 'button'}, mk('img', {src: 'icons/rotate-right.png'}));
        rotate_right_button.addEventListener('click', ev => {
            this.rotate_tile_right(this.fg_tile);
            this.redraw_foreground_tile();
        });
        let rotate_left_button = mk('button.--image', {type: 'button'}, mk('img', {src: 'icons/rotate-left.png'}));
        rotate_left_button.addEventListener('click', ev => {
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
        for (let toolname of EDITOR_TOOL_ORDER) {
            let tooldef = EDITOR_TOOLS[toolname];
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
        this.undo_button = _make_button("Undo", ev => {
            this.undo();
        });
        this.redo_button = _make_button("Redo", ev => {
            this.redo();
        });
        _make_button("Pack properties...", ev => {
            new EditorPackMetaOverlay(this.conductor, this.conductor.stored_game).open();
        });
        _make_button("Level properties...", ev => {
            new EditorLevelMetaOverlay(this.conductor, this.stored_level).open();
        });
        this.save_button = _make_button("Save", ev => {
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
                new EditorShareOverlay(this.conductor, url.toString()).open();
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
                        new EditorExportFailedOverlay(this.conductor, errs.errors).open();
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
        for (let sectiondef of EDITOR_PALETTE) {
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

        let index = EDITOR_ZOOM_LEVELS.findIndex(el => el >= this.zoom);
        if (index < 0) {
            index = EDITOR_ZOOM_LEVELS.length - 1;
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
            this._level_browser = new EditorLevelBrowserOverlay(this.conductor);
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
        if (this.current_tool && EDITOR_TOOLS[this.current_tool].op1) {
            this.mouse_op = new EDITOR_TOOLS[this.current_tool].op1(this, ...(this.mouse_coords ?? [0, 0]), 0);  // FIXME?
        }
    }

    show_palette_tooltip(key) {
        let desc = EDITOR_TILE_DESCRIPTIONS[key];
        if (! desc && SPECIAL_PALETTE_ENTRIES[key]) {
            let name = SPECIAL_PALETTE_ENTRIES[key].name;
            desc = EDITOR_TILE_DESCRIPTIONS[name];
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
        if (SPECIAL_PALETTE_BEHAVIOR[name]) {
            key = SPECIAL_PALETTE_BEHAVIOR[name].pick_palette_entry(tile);
        }
        this.palette_fg_selected_el = this.palette[key] ?? null;
        if (this.palette_fg_selected_el) {
            this.palette_fg_selected_el.classList.add('--selected');
        }

        this.redraw_foreground_tile();

        // Some tools obviously don't work with a palette selection, in which case changing tiles
        // should default you back to the pencil
        if (! EDITOR_TOOLS[this.current_tool].uses_palette) {
            this.select_tool('pencil');
        }
    }

    select_background_tile(name_or_tile) {
        let [name, tile] = this._name_or_tile_to_name_and_tile(name_or_tile);

        this.bg_tile = tile;

        this.redraw_background_tile();
    }

    rotate_tile_left(tile) {
        if (SPECIAL_PALETTE_BEHAVIOR[tile.type.name]) {
            SPECIAL_PALETTE_BEHAVIOR[tile.type.name].rotate_left(tile);
        }
        else if (TILE_TYPES[tile.type.name].is_actor) {
            tile.direction = DIRECTIONS[tile.direction ?? 'south'].left;
        }
        else {
            return false;
        }

        return true;
    }

    rotate_tile_right(tile) {
        if (SPECIAL_PALETTE_BEHAVIOR[tile.type.name]) {
            SPECIAL_PALETTE_BEHAVIOR[tile.type.name].rotate_right(tile);
        }
        else if (TILE_TYPES[tile.type.name].is_actor) {
            tile.direction = DIRECTIONS[tile.direction ?? 'south'].right;
        }
        else {
            return false;
        }

        return true;
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
            SPECIAL_PALETTE_BEHAVIOR[tile.type.name] &&
            SPECIAL_PALETTE_BEHAVIOR[tile.type.name].combine_draw)
        {
            let old_tile = {...existing_tile};
            let new_tile = existing_tile;
            SPECIAL_PALETTE_BEHAVIOR[tile.type.name].combine_draw(tile, new_tile);
            this._assign_tile(cell, layer, new_tile, old_tile);
            return;
        }

        let new_tile = {...tile};
        // Special case: preserve wires when replacing one wired tile with another
        if (new_tile.type.contains_wire &&
            // FIXME this is hacky garbage
            tile === this.fg_tile && this.fg_tile_from_palette)
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
            SPECIAL_PALETTE_BEHAVIOR[tile.type.name] &&
            SPECIAL_PALETTE_BEHAVIOR[tile.type.name].combine_erase)
        {
            let old_tile = {...existing_tile};
            let new_tile = existing_tile;
            let remove = SPECIAL_PALETTE_BEHAVIOR[tile.type.name].combine_erase(tile, new_tile);
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
            this.update_viewport_size();
            this.update_cell_coordinates();
            this.redraw_entire_level();
        }, () => {
            this.stored_level.linear_cells = original_cells;
            this.stored_level.size_x = original_size_x;
            this.stored_level.size_y = original_size_y;
            this.update_viewport_size();
            this.update_cell_coordinates();
            this.redraw_entire_level();
        });
        this.commit_undo();
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
        for (let [undo, redo] of entry) {
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

    commit_undo(label = null) {
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
