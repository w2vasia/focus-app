use comrak::{Options, markdown_to_html};

const EXPORT_CSS: &str = include_str!("export.css");

fn options() -> Options<'static> {
    let mut opts = Options::default();
    opts.extension.strikethrough = true;
    opts.extension.table = true;
    opts.extension.autolink = true;
    opts.extension.tasklist = true;
    opts.extension.footnotes = true;
    // Extended syntax from markdownguide.org/cheat-sheet
    opts.extension.superscript = true; // X^2^
    opts.extension.subscript = true; // H~2~O (strikethrough keeps ~~)
    opts.extension.highlight = true; // ==text==
    opts.extension.description_lists = true; // term\n: definition
    opts.extension.shortcodes = true; // :joy:
    opts
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// Private-use sentinels that carry a custom heading id through the renderer.
// They are stripped from user input first, so only `mark_heading_ids` can produce them.
const ID_OPEN: char = '\u{E000}';
const ID_CLOSE: char = '\u{E001}';

fn is_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The ATX heading body of a line (`> ## Title {#id}` → `Title {#id}` with level), if it is one.
/// Indented 4+ spaces is a code block, not a heading.
fn atx_heading(line: &str) -> Option<&str> {
    let mut rest = line.trim_end_matches(['\n', '\r']);
    loop {
        let indent = rest.len() - rest.trim_start_matches(' ').len();
        if indent >= 4 || rest.starts_with('\t') {
            return None;
        }
        rest = rest.trim_start_matches(' ');
        match rest.strip_prefix('>') {
            Some(after) => rest = after,
            None => break,
        }
    }
    let hashes = rest.len() - rest.trim_start_matches('#').len();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    rest[hashes..]
        .strip_prefix(' ')
        .or_else(|| rest[hashes..].strip_prefix('\t'))
}

/// Opening fence marker (``` or ~~~, possibly longer) of a line, if any.
fn fence_marker(line: &str) -> Option<(char, usize)> {
    let t = line.trim_start_matches(' ');
    if line.len() - t.len() >= 4 {
        return None;
    }
    let c = t.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let n = t.chars().take_while(|x| *x == c).count();
    (n >= 3).then_some((c, n))
}

/// `### Heading {#custom-id}` → heading text followed by a sentinel-wrapped id.
/// comrak parses header attributes but does not render them, so we do it here.
fn mark_heading_ids(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut fence: Option<(char, usize)> = None;
    for line in markdown.split_inclusive('\n') {
        if let Some((c, n)) = fence {
            // A fence closes only with the same character, at least as long, and nothing else.
            if fence_marker(line)
                .is_some_and(|(c2, n2)| c2 == c && n2 >= n && line.trim().chars().all(|x| x == c))
            {
                fence = None;
            }
        } else if let Some(marker) = fence_marker(line) {
            fence = Some(marker);
        } else if let Some(body) = atx_heading(line) {
            let body = body.trim_end();
            if let Some(start) = body.rfind("{#")
                && body.ends_with('}')
                && is_id(&body[start + 2..body.len() - 1])
            {
                let id = &body[start + 2..body.len() - 1];
                let keep = &line[..line.len() - line.trim_start().len()]; // leading indent
                let head = line.trim_start();
                let cut = head.rfind("{#").expect("found above");
                let eol = &line[line.trim_end().len()..];
                out.push_str(&format!(
                    "{keep}{} {ID_OPEN}{id}{ID_CLOSE}{eol}",
                    head[..cut].trim_end()
                ));
                continue;
            }
        }
        out.push_str(line);
    }
    out
}

/// Moves each sentinel id onto its `<hN>` tag as an `id` attribute. A token only counts when it
/// ends the heading (directly before `</hN>`) and holds a valid id; otherwise it is dropped.
fn apply_heading_ids(html: String) -> String {
    const TAGS: [&str; 6] = ["<h1>", "<h2>", "<h3>", "<h4>", "<h5>", "<h6>"];
    // One pass (linear): copy the text between tokens, remembering where the latest `<hN>` of
    // each level landed in `out`; the id attributes are spliced in at the end.
    let mut out = String::with_capacity(html.len());
    let mut last: [Option<usize>; 6] = [None; 6];
    let mut inserts: Vec<(usize, String)> = Vec::new();
    let mut used = std::collections::HashSet::new();
    let copy = |out: &mut String, last: &mut [Option<usize>; 6], chunk: &str| {
        for (slot, tag) in last.iter_mut().zip(TAGS) {
            if let Some(i) = chunk.rfind(tag) {
                *slot = Some(out.len() + i);
            }
        }
        out.push_str(chunk);
    };
    let mut pos = 0;
    while let Some(rel) = html[pos..].find(ID_OPEN) {
        let open = pos + rel;
        copy(&mut out, &mut last, &html[pos..open]);
        let body = open + ID_OPEN.len_utf8();
        let Some(close) = html[body..].find(ID_CLOSE).map(|i| body + i) else {
            pos = body; // stray opener: drop it
            continue;
        };
        let id = &html[body..close];
        let after = close + ID_CLOSE.len_utf8();
        pos = after;
        if out.ends_with(' ') {
            out.pop();
        }
        let level = html[after..]
            .get(..5)
            .filter(|t| t.starts_with("</h") && t.ends_with('>'))
            .and_then(|t| t[3..4].parse::<usize>().ok())
            .filter(|l| (1..=6).contains(l));
        let (Some(level), true) = (level, is_id(id)) else {
            continue;
        };
        if let Some(at) = last[level - 1].take() {
            let mut unique = id.to_string();
            let mut n = 2;
            while !used.insert(unique.clone()) {
                unique = format!("{id}-{n}");
                n += 1;
            }
            inserts.push((
                at + TAGS[level - 1].len() - 1,
                format!(" id=\"{}\"", escape(&unique)),
            ));
        }
    }
    copy(&mut out, &mut last, &html[pos..]);
    if inserts.is_empty() {
        return out;
    }
    inserts.sort_by_key(|(at, _)| *at);
    let extra: usize = inserts.iter().map(|(_, a)| a.len()).sum();
    let mut result = String::with_capacity(out.len() + extra);
    let mut prev = 0;
    for (at, attr) in &inserts {
        result.push_str(&out[prev..*at]);
        result.push_str(attr);
        prev = *at;
    }
    result.push_str(&out[prev..]);
    result
}

/// Body HTML only (used for the in-app preview and print view). Async so large documents
/// render on a worker thread, not the main (UI) thread.
#[tauri::command]
pub async fn render_markdown(markdown: String) -> String {
    render_body(&markdown)
}

pub fn render_body(markdown: &str) -> String {
    let clean = markdown.replace([ID_OPEN, ID_CLOSE], "");
    apply_heading_ids(markdown_to_html(&mark_heading_ids(&clean), &options()))
}

/// Standalone HTML document with embedded styles.
pub fn render_document(markdown: &str, title: &str) -> String {
    let body = render_body(markdown);
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{}</title>\n<style>{EXPORT_CSS}</style>\n</head>\n<body>\n<article>\n{body}</article>\n</body>\n</html>\n",
        escape(title)
    )
}

#[tauri::command]
pub async fn export_html(
    scope: tauri::State<'_, crate::scope::Scope>,
    markdown: String,
    title: String,
    path: String,
) -> Result<(), String> {
    // Only the exact file just picked in the HTML Save dialog, once (R4-M3).
    let path = scope.take_export(&path)?;
    crate::files::write_atomic(&path, render_document(&markdown, &title).as_bytes())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn print_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_gfm() {
        let html = render_body("# Hi\n\n~~old~~ | a |\n\n- [x] done\n");
        assert!(html.contains("<h1>Hi</h1>"));
        assert!(html.contains("<del>old</del>"));
        assert!(html.contains("checkbox"));
    }

    #[test]
    fn renders_extended_syntax() {
        let md = "### Title {#custom-id}\n\nH~2~O X^2^ ==hi== ~~old~~ :joy:\n\nTerm\n: Def\n\nNote[^1]\n\n[^1]: Foot.\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n";
        let html = render_body(md);
        for needle in [
            "id=\"custom-id\"",
            "<sub>2</sub>",
            "<sup>2</sup>",
            "<mark>hi</mark>",
            "<del>old</del>",
            "😂",
            "<dt>Term</dt>",
            "footnote",
            "<table>",
        ] {
            assert!(html.contains(needle), "missing {needle} in:\n{html}");
        }
    }

    /// Every Basic + Extended item from markdownguide.org/cheat-sheet must survive export,
    /// Split and Read views (all of which use this renderer).
    #[test]
    fn renders_whole_cheat_sheet() {
        let html = render_body(include_str!("../../tests/cheat-sheet.md"));
        let expected = [
            ("heading 1", "<h1>H1</h1>"),
            ("heading 2", "<h2>H2</h2>"),
            ("heading 3", "<h3>H3</h3>"),
            ("bold", "<strong>bold text</strong>"),
            ("italic", "<em>italicized text</em>"),
            ("blockquote", "<blockquote>"),
            ("ordered list", "<ol>"),
            ("unordered list", "<ul>"),
            ("code", "<code>code</code>"),
            ("horizontal rule", "<hr />"),
            ("link", "<a href=\"https://www.example.com\">title</a>"),
            ("image", "<img src=\"image.jpg\" alt=\"alt text\""),
            ("table", "<th>Syntax</th>"),
            ("fenced code block", "<pre><code>{"),
            ("footnote reference", "data-footnote-ref"),
            ("footnote definition", "This is the footnote."),
            ("heading id", "<h3 id=\"custom-id\">My Great Heading</h3>"),
            ("definition list", "<dt>term</dt>"),
            ("strikethrough", "<del>The world is flat.</del>"),
            ("task list", "type=\"checkbox\" checked=\"\""),
            ("emoji", "😂"),
            ("highlight", "<mark>very important words</mark>"),
            ("subscript", "H<sub>2</sub>O"),
            ("superscript", "X<sup>2</sup>"),
        ];
        let missing: Vec<_> = expected
            .iter()
            .filter(|(_, n)| !html.contains(n))
            .map(|(name, _)| *name)
            .collect();
        assert!(missing.is_empty(), "missing {missing:?} in:\n{html}");
    }

    #[test]
    fn heading_ids_skip_code_fences() {
        let html = render_body("```\n## Not {#x}\n```\n\n## Yes {#y}\n");
        assert!(html.contains("## Not {#x}"));
        assert!(html.contains("<h2 id=\"y\">Yes</h2>"));
    }

    /// H1: user text must not be able to forge the heading-id sentinels.
    #[test]
    fn sentinels_in_user_text_cannot_inject() {
        let html = render_body(
            "# Title\n\npara \u{E000}[a](y) onmouseover=alert(1) z [b](w)\u{E001} end\n\nkeep \u{E000}code\u{E001} me\n",
        );
        assert!(html.contains("<h1>Title</h1>"), "{html}");
        assert!(!html.contains(" id="), "no id may be produced: {html}");
        assert!(
            html.contains("keep code me"),
            "text between fake markers must survive: {html}"
        );
        assert!(!html.contains('\u{E000}') && !html.contains('\u{E001}'));
    }

    #[test]
    fn heading_ids_need_a_real_heading() {
        // indented code is not a heading; a ```` fence is not closed by ```
        let html = render_body(
            "    # x {#y}\n\n````\n```\n## In {#nope}\n````\n\n## Out {#out}\n## Out {#out}\n",
        );
        assert!(!html.contains("id=\"y\""), "{html}");
        assert!(!html.contains("id=\"nope\""), "{html}");
        assert!(html.contains("<h2 id=\"out\">Out</h2>"), "{html}");
        assert!(
            html.contains("<h2 id=\"out-2\">Out</h2>"),
            "duplicate ids get a suffix: {html}"
        );
        assert!(render_body("> ## Quoted {#q}\n").contains("<h2 id=\"q\">"));
    }

    #[test]
    fn document_escapes_title_and_embeds_css() {
        let doc = render_document("text", "<b>&");
        assert!(doc.contains("<title>&lt;b&gt;&amp;</title>"));
        assert!(doc.contains("<style>"));
        assert!(!render_body("<script>x</script>").contains("<script>"));
    }

    /// R3-L4: ids are unique, land on their own heading, and many headings stay fast (linear).
    #[test]
    fn heading_ids_dedupe_and_scale() {
        let html = render_body("## A {#a}\n\n## Plain\n\n## A {#a}\n\n### B {#b}\n");
        assert!(html.contains("<h2 id=\"a\">A</h2>"), "{html}");
        assert!(html.contains("<h2>Plain</h2>"), "{html}");
        assert!(html.contains("<h2 id=\"a-2\">A</h2>"), "{html}");
        assert!(html.contains("<h3 id=\"b\">B</h3>"), "{html}");

        let md: String = (0..20_000)
            .map(|i| format!("## H{i} {{#h{i}}}\n\ntext\n\n"))
            .collect();
        let t = std::time::Instant::now();
        let html = render_body(&md);
        assert!(html.contains("<h2 id=\"h19999\">H19999</h2>"));
        assert!(
            t.elapsed() < std::time::Duration::from_secs(5),
            "{:?}",
            t.elapsed()
        );
    }
}
