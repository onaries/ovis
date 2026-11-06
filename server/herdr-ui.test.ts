import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHerdrUi } from "./herdr-ui.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function config(contents: string | Buffer): string {
  const root = mkdtempSync(join(tmpdir(), "ovis-herdr-ui-"));
  roots.push(root);
  const path = join(root, "config.toml");
  writeFileSync(path, contents);
  return path;
}

describe("herdr's [ui] copy_on_select", () => {
  it("reads the value herdr's config sets", () => {
    expect(readHerdrUi(config("[ui]\ncopy_on_select = false\n")).copy_on_select).toBe(false);
    expect(readHerdrUi(config("[ui]\ncopy_on_select = true\n")).copy_on_select).toBe(true);
    expect(readHerdrUi(config("[ui]\r\ntheme = 'dark'\r\ncopy_on_select = false\r\n")).copy_on_select).toBe(false);
  });

  it("reads it past the byte-order marks herdr strips at the start of a line", () => {
    expect(readHerdrUi(config("\uFEFF[ui]\n\uFEFFcopy_on_select = false\n")).copy_on_select).toBe(false);
  });

  it("is herdr's default (on) for a value that is no boolean, another table, no config or no TOML", () => {
    for (const contents of ["", "[ui]\ntheme = 'dark'", "[other]\ncopy_on_select = false", "[ui]\ncopy_on_select = 'false'", "[ui]\ncopy_on_select = 0", "ui = false", "[ui"]) {
      expect(readHerdrUi(config(contents)).copy_on_select).toBe(true);
    }
    const root = mkdtempSync(join(tmpdir(), "ovis-herdr-ui-"));
    roots.push(root);
    expect(readHerdrUi(join(root, "missing.toml")).copy_on_select).toBe(true);
    expect(readHerdrUi(root).copy_on_select).toBe(true);
  });

  it("reads no special file, and no file larger than a config", () => {
    expect(readHerdrUi(config(Buffer.alloc(1024 * 1024 + 1, "#"))).copy_on_select).toBe(true);
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "ovis-herdr-ui-"));
    roots.push(root);
    const fifo = join(root, "config.toml");
    Bun.spawnSync(["mkfifo", fifo]);
    // a FIFO with no writer would block a plain read: it is no config, read at once
    expect(readHerdrUi(fifo).copy_on_select).toBe(true);
  });
});

describe("herdr's [keys] prefix bindings", () => {
  const keysOf = (toml: string) => readHerdrUi(config(toml)).keys!;

  it("are herdr's defaults without a config, without [keys], or with a config herdr cannot parse", () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-herdr-ui-"));
    roots.push(root);
    const defaults = readHerdrUi(join(root, "missing.toml")).keys!;
    expect(defaults.prefix).toBe("ctrl+b");
    expect(defaults.bindings).toMatchObject({ new_tab: ["prefix+c"], switch_tab: ["prefix+1..9"], split_horizontal: ["prefix+minus"], next_workspace: [] });
    expect(keysOf("[ui]\ncopy_on_select = false\n")).toEqual(defaults);
    expect(keysOf("[keys")).toEqual(defaults);
    // a value of a type herdr does not read makes herdr read no config: its defaults stand
    expect(keysOf('[keys]\nprefix = 1\nnew_tab = "prefix+t"\n')).toEqual(defaults);
    expect(keysOf('[keys]\nzoom = 3\n')).toEqual(defaults);
  });

  it("take the prefix and the bindings the config writes, one or a list, an empty one unbinding the action", () => {
    const keys = keysOf('[keys]\nprefix = "ctrl+a"\nnew_tab = ["prefix+c", "prefix+t"]\nzoom = ""\nnext_workspace = "prefix+shift+right"\n');
    expect(keys.prefix).toBe("ctrl+a");
    expect(keys.bindings).toMatchObject({ new_tab: ["prefix+c", "prefix+t"], zoom: [], next_workspace: ["prefix+shift+right"] });
  });

  it("let a binding the config writes take a default's key, whatever action it is for (as herdr's user-before-default passes)", () => {
    const zoom = keysOf('[keys]\nzoom = "prefix+?"\n');
    expect(zoom.bindings.zoom).toEqual(["prefix+?"]);
    expect(zoom.bindings.help).toEqual([]);
    // an action the app does not run still takes its key from one it does
    expect(keysOf('[keys]\nclose_pane = "prefix+c"\n').bindings.new_tab).toEqual([]);
    // and so does a custom command, whose body is never returned
    const command = keysOf('[[keys.command]]\nkey = "prefix+v"\ntype = "shell"\ncommand = "rm -rf ~"\n');
    expect(command.bindings.split_vertical).toEqual([]);
    expect(JSON.stringify(command)).not.toContain("rm -rf");
    // a command herdr skips takes no key
    expect(keysOf('[[keys.command]]\nkey = "prefix+v"\ncommand = ""\n').bindings.split_vertical).toEqual(["prefix+v"]);
  });

  it("keep herdr's rules for indexed actions, the prefix and its fallback", () => {
    expect(keysOf('[keys]\nswitch_tab = "prefix+3"\n').bindings.switch_tab).toEqual(["prefix+3"]);
    expect(keysOf('[keys]\nswitch_tab = "prefix+t"\nnew_tab = "prefix+1..9"\n').bindings).toMatchObject({ switch_tab: [], new_tab: [] });
    // a [keys.indexed] entry is the user's own tab keys: the prefix+1..9 default stands down
    expect(keysOf('[keys.indexed]\ntabs = "ctrl"\n').bindings.switch_tab).toEqual([]);
    // a user binding on one digit leaves the default range its other eight
    expect(keysOf('[keys]\nnext_tab = "prefix+2"\n').bindings.switch_tab).toEqual(["prefix+1", "prefix+3", "prefix+4", "prefix+5", "prefix+6", "prefix+7", "prefix+8", "prefix+9"]);
    // the prefix as its own second key sends the prefix: that binding is dropped
    expect(keysOf('[keys]\nprefix = "ctrl+a"\nnew_tab = "prefix+ctrl+a"\n').bindings.new_tab).toEqual([]);
    // an unreadable prefix is herdr's ctrl+b
    expect(keysOf('[keys]\nprefix = "nonsense+key"\n').prefix).toBe("ctrl+b");
    expect(keysOf('[keys]\nprefix = "ctrl+space"\n').prefix).toBe("ctrl+space");
    expect(keysOf('[keys]\nfullscreen = "prefix+f"\n').bindings.zoom).toEqual(["prefix+f"]);
  });

  it("take every prefix a list or extra_prefixes writes, as herdr merges them", () => {
    const both = keysOf('[keys]\nprefix = ["ctrl+a", "ctrl+b"]\nnew_tab = "prefix+t"\n');
    expect([both.prefix, both.prefixes]).toEqual(["ctrl+a", ["ctrl+a", "ctrl+b"]]);
    expect(both.bindings.new_tab).toEqual(["prefix+t"]);
    expect(keysOf('[keys]\nprefix = ["ctrl+a"]\n').prefixes).toEqual(["ctrl+a"]);
    expect(keysOf('[keys]\nprefix = "ctrl+a"\nextra_prefixes = ["ctrl+space"]\n').prefixes).toEqual(["ctrl+a", "ctrl+space"]);
    // an entry herdr cannot read is skipped, a repeat kept once; with none left, herdr's ctrl+b
    expect(keysOf('[keys]\nprefix = ["nonsense+key", "ctrl+a", "control+a"]\n').prefixes).toEqual(["ctrl+a"]);
    expect(keysOf('[keys]\nprefix = []\n').prefixes).toEqual(["ctrl+b"]);
    // a prefix binding on any of the prefixes sends that prefix: dropped
    expect(keysOf('[keys]\nprefix = ["ctrl+a", "ctrl+b"]\nnew_tab = "prefix+ctrl+b"\n').bindings.new_tab).toEqual([]);
    expect(keysOf('[keys]\nprefix = ["ctrl+a", 1]\nnew_tab = "prefix+t"\n').bindings.new_tab).toEqual(["prefix+c"]);
    // nor are the indexed keys or commands of a config herdr does not read
    const unread = keysOf('[keys]\nextra_prefixes = 1\n[keys.indexed]\ntabs = "ctrl"\n[[keys.command]]\nkey = "prefix+c"\ncommand = "echo hi"\n');
    expect(unread.bindings).toMatchObject({ switch_tab: ["prefix+1..9"], new_tab: ["prefix+c"] });
    // the plus key is a prefix, so a binding on it is dropped
    const plus = keysOf('[keys]\nprefix = ["ctrl+a", "+"]\nnew_tab = "prefix+plus"\n');
    expect([plus.prefixes, plus.bindings.new_tab]).toEqual([["ctrl+a", "+"], []]);
    expect(keysOf('[keys]\nclear_pane = "prefix++"\nzoom = "prefix+plus"\n').bindings.zoom).toEqual([]);
  });

  it("let every action herdr registers take a default's key, those the app does not run included", () => {
    expect(keysOf('[keys]\nclear_pane = "prefix+c"\n').bindings.new_tab).toEqual([]);
    expect(keysOf('[keys]\nmove_tab_next = "prefix+n"\n').bindings.next_tab).toEqual([]);
    expect(keysOf('[keys]\nresize_pane_left = "prefix+v"\n').bindings.split_vertical).toEqual([]);
    expect(keysOf('[keys]\nclear_pane = 3\nnew_tab = "prefix+t"\n').bindings.new_tab).toEqual(["prefix+c"]);
  });
});
