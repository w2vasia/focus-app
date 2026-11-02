import { EditorState, TransactionSpec } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { extendedSyntax } from "../src/editor/syntax.ts";
import * as preview from "../src/editor/livePreview.ts";
import * as remote from "../src/editor/remoteImages.ts";
import { imageSourcePos } from "../src/editor/widgets.ts";

let failed = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};

function fakeView(doc: string) {
  const view: any = {
    state: EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, extensions: extendedSyntax }) }),
    hasFocus: false,
    viewport: { from: 0, to: doc.length },
    dispatched: [] as TransactionSpec[],
    dispatch(spec: TransactionSpec) {
      view.dispatched.push(spec);
      view.state = view.state.update(spec).state;
    },
    focus() {},
  };
  ensureSyntaxTree(view.state, doc.length, 5000);
  return view;
}
const images = (view: any) => {
  const out: any[] = [];
  preview.buildDecorations(view).between(0, view.state.doc.length, (_f, _t, d) => {
    const w = (d as any).spec.widget;
    if (w?.constructor?.name === "ImageWidget") out.push(w);
  });
  return out;
};

// (a) the same URL twice: allowing it must yield widgets that differ from the placeholders,
// so CodeMirror redraws *both* copies instead of reusing the placeholder DOM.
const url = "https://example.com/a.png";
const v = fakeView(`![one](${url})\n\n![one](${url})\n`);
const before = images(v);
check("two image widgets", before.length === 2, before.length);
remote.allowRemote(url);
const after = images(v);
check("allowed widget is not eq() to its placeholder", after.length === 2 && !after[0].eq(before[0]) && !after[1].eq(before[1]));
check("two allowed copies are eq() to each other", after[0].eq(after[1]));

// (b) a command that loads every remote image (for a menu item / shortcut)
const load = (preview as any).loadRemoteImages ?? (remote as any).loadRemoteImages;
check("loadRemoteImages is exported", typeof load === "function");
if (typeof load === "function") {
  const w = fakeView("![a](https://img.example/x.png) and ![b](https://img.example/y.png)\n\n![c](local.png)");
  check("loadRemoteImages returns true", load(w) === true);
  check("loadRemoteImages allows every remote URL", remote.remoteAllowed("https://img.example/x.png") && remote.remoteAllowed("https://img.example/y.png"));
  const effects = w.dispatched.flatMap((s: any) => [s.effects ?? []].flat());
  check("loadRemoteImages dispatches a rebuild effect", effects.some((e: any) => e.is?.((remote as any).remoteImagesAllowed)), effects.length);
  check("loadRemoteImages without remote images returns false", load(fakeView("![c](local.png)")) === false);
}

// (c) http: images can't load under the CSP (img-src https:), so they're never "allowed"
remote.allowRemote("http://insecure.example/p.png");
check("http: image is not allowed", !remote.remoteAllowed("http://insecure.example/p.png"));
check("http: image is not loadable", typeof (remote as any).canLoadRemote === "function" && !(remote as any).canLoadRemote("http://insecure.example/p.png"));

// R3-L3 (a): on a document the parser hasn't finished, images past the parsed part are still found
{
  const filler = "Lorem ipsum dolor sit amet, **consectetur** adipiscing elit.\n\n".repeat(40000); // ~2.5 MB
  const doc = "![top](https://img.example/top.png)\n\n" + filler + "![late](https://img.example/late.png) and ![l2](<https://img.example/l2.png>)\n";
  const huge: any = {
    state: EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, extensions: extendedSyntax }) }),
    dispatched: [] as TransactionSpec[],
    dispatch(spec: TransactionSpec) { huge.dispatched.push(spec); huge.state = huge.state.update(spec).state; },
    focus() {},
  };
  const { syntaxTree } = await import("@codemirror/language");
  check("precondition: the huge document is only partly parsed", syntaxTree(huge.state).length < doc.length, syntaxTree(huge.state).length);
  check("loadRemoteImages (no parse budget) returns true", (preview as any).loadRemoteImages(huge, 0) === true);
  check("…allows the image in the parsed part", remote.remoteAllowed("https://img.example/top.png"));
  check("…and the images past the parsed part", remote.remoteAllowed("https://img.example/late.png") && remote.remoteAllowed("https://img.example/l2.png"));
  check("…with a single rebuild dispatch", huge.dispatched.length === 1, huge.dispatched.length);
}

// R4-L5 (c): the unparsed-tail scan keeps balanced parens in URLs and skips fenced code
{
  const hugeView = (doc: string) => {
    const hv: any = {
      state: EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, extensions: extendedSyntax }) }),
      dispatch(spec: TransactionSpec) { hv.state = hv.state.update(spec).state; },
      focus() {},
    };
    return hv;
  };
  const filler = "Lorem ipsum dolor sit amet, **consectetur** adipiscing elit.\n\n".repeat(40000);
  const paren = "https://img.example/a_(b).png";
  const tail =
    `![p](${paren})\n\n` +
    "```md\n![f](https://img.example/fenced.png)\n~~~\n![f2](https://img.example/fenced2.png)\n```\n\n" +
    "~~~~\n![t](https://img.example/tilde.png)\n~~~\n```\n![t2](https://img.example/tilde2.png)\n~~~~~\n\n" +
    "![after](https://img.example/after.png)\n";
  const hv = hugeView(filler + tail);
  const { syntaxTree } = await import("@codemirror/language");
  check("precondition: the tail is past the parsed part", syntaxTree(hv.state).length < filler.length, syntaxTree(hv.state).length);
  (preview as any).loadRemoteImages(hv, 0);
  check("tail scan: URL with balanced parens allowed whole", remote.remoteAllowed(paren) && !remote.remoteAllowed("https://img.example/a_(b"));
  check("tail scan: images inside ``` / ~~~ fences are skipped (inner shorter/other fences don't close)",
    !["fenced", "fenced2", "tilde", "tilde2"].some((n) => remote.remoteAllowed(`https://img.example/${n}.png`)));
  check("tail scan: image after the fences is allowed", remote.remoteAllowed("https://img.example/after.png"));
  // lezer agrees on what the tail means
  const full = EditorState.create({ doc: tail, extensions: markdown({ base: markdownLanguage, extensions: extendedSyntax }) });
  const urls: string[] = [];
  ensureSyntaxTree(full, tail.length, 5000)!.iterate({ enter: (n) => { if (n.name === "Image") { const u = n.node.getChild("URL"); if (u) urls.push(full.sliceDoc(u.from, u.to)); } } });
  check("lezer parses the same images out of the tail", JSON.stringify(urls) === JSON.stringify([paren, "https://img.example/after.png"]), urls);

}

// R3-L3 (b): clicking an http placeholder puts the caret into the image's source (URL start)
{
  const parsed = (doc: string) => {
    const st = EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, extensions: extendedSyntax }) });
    ensureSyntaxTree(st, doc.length, 5000);
    return st;
  };
  const st = parsed("text ![a [b] c](http://x.example/p.png) more");
  check("caret lands at the URL start (nested brackets in alt)", imageSourcePos(st, 5) === st.doc.toString().indexOf("http"), imageSourcePos(st, 5));
  const angle = parsed("![a](<http://x.example/p.png>)");
  check("…inside <angle> destinations too", [5, 6].includes(imageSourcePos(angle, 0)), imageSourcePos(angle, 0));
  const wrapped = parsed("![multi\nline](http://x.example/p.png)");
  check("…or just inside `![` when the URL is on another line", imageSourcePos(wrapped, 0) === 2, imageSourcePos(wrapped, 0));
}

process.exit(failed);
