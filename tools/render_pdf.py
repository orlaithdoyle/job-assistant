"""Turn a simple Markdown CV or cover letter into a PDF set in Times New Roman.

Usage: python3 tools/render_pdf.py input.md output.pdf [--style classic|modern|elegant]   (classic is the default and Orlaith's chosen design)

Markdown supported:
  "# Name"                 CV title (a file without one is treated as a cover letter)
  "## Section"             section heading
  "- item"                 bullet
  "Left || Right"          one line with Right flush right (use for job title || dates)
  "> line"                 right-aligned block (cover letter sender details)
  **bold**, *italic*, blank lines between paragraphs; single line breaks are kept.

House rules: a CV is never more than 2 pages, a cover letter never more than 1.
CV sections (and each job or degree entry) are never split across pages; if that pushes the CV
to 3 pages it fails with TOO LONG, so shorten the text.
Requires: pip install reportlab
"""
import argparse
import re
import sys
from functools import partial

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import (CondPageBreak, HRFlowable, KeepTogether, ListFlowable, ListItem, Paragraph,
                                SimpleDocTemplate, Spacer, Table, TableStyle)

# PDF standard Times fonts: shown as Times New Roman on Windows and Times on Mac.
REG, BOLD, ITAL = "Times-Roman", "Times-Bold", "Times-Italic"

THEMES = {
    # Centred name, black, capitalised headings with a full-width rule.
    "classic": dict(ink="#000000", accent="#000000", muted="#333333", name_size=22, name_align=TA_CENTER,
                    head_upper=True, head_size=11.5, rule=0.7, rule_color="#000000", body=10.5, lead=13.4),
    # Left-aligned navy name, navy headings, softer grey contact line.
    "modern": dict(ink="#1a1a1a", accent="#1f3a5f", muted="#555555", name_size=26, name_align=TA_LEFT,
                   head_upper=False, head_size=13, rule=1.2, rule_color="#1f3a5f", body=10.5, lead=13.6),
    # Centred name with a fine rule under the header, small navy capital headings, extra air.
    "elegant": dict(ink="#111111", accent="#1f3a5f", muted="#444444", name_size=24, name_align=TA_CENTER,
                    head_upper=True, head_size=10.5, rule=0.4, rule_color="#8a8a8a", body=10.5, lead=13.8),
}


def inline(text):
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<i>\1</i>", text)
    return text


def styles_for(theme, letter):
    t = THEMES[theme]
    ink = colors.HexColor(t["ink"])
    if letter:  # cover letters stay plain whatever the CV design: 11pt, a blank line between blocks
        base = ParagraphStyle("lbase", fontName=REG, fontSize=11, leading=14, textColor=colors.black, spaceAfter=14)
    else:
        base = ParagraphStyle("base", fontName=REG, fontSize=t["body"], leading=t["lead"], textColor=ink, spaceAfter=4)
    return dict(
        t=t,
        base=base,
        right=ParagraphStyle("right", parent=base, alignment=TA_RIGHT),
        title=ParagraphStyle("title", parent=base, fontName=BOLD, fontSize=t["name_size"], leading=t["name_size"] + 4,
                             alignment=t["name_align"], spaceAfter=4,
                             textColor=colors.HexColor(t["accent"]) if theme == "modern" else ink),
        contact=ParagraphStyle("contact", parent=base, fontSize=9.8, leading=12.5, alignment=t["name_align"],
                               textColor=colors.HexColor(t["muted"]), spaceAfter=2),
        section=ParagraphStyle("section", parent=base, fontName=BOLD, fontSize=t["head_size"],
                               leading=t["head_size"] + 3, textColor=colors.HexColor(t["accent"]),
                               spaceBefore=11 if theme == "elegant" else 12, spaceAfter=0),
        bullet=ParagraphStyle("bullet", parent=base, spaceAfter=1.5),
        rowl=ParagraphStyle("rowl", parent=base, spaceAfter=0, spaceBefore=3),
        rowr=ParagraphStyle("rowr", parent=base, fontName=ITAL, alignment=TA_RIGHT, spaceAfter=0, spaceBefore=3,
                            textColor=colors.HexColor(t["muted"])),
    )


def build(md_text, theme):
    lines = md_text.splitlines()
    letter = not any(l.startswith("# ") for l in lines)
    S = styles_for(theme, letter)
    t = S["t"]
    story, para, items, rblock = [], [], [], []
    state = {"after_title": False, "header_done": letter}
    marks = []  # (index in story, "section" | "entry") so sections and entries can be kept whole
    width = A4[0] - 2 * 19 * mm - 12  # frame has 6pt padding each side

    def end_header():
        if not state["header_done"]:
            state["header_done"] = True
            if theme == "elegant":
                story.append(HRFlowable(width="100%", thickness=0.6, color=colors.HexColor("#8a8a8a"),
                                        spaceBefore=4, spaceAfter=2))
            else:
                story.append(HRFlowable(width="100%", thickness=1.4, color=colors.HexColor(t["rule_color"]),
                                        spaceBefore=5, spaceAfter=3))

    def flush_para():
        nonlocal para, rblock
        if rblock:
            story.append(Paragraph("<br/>".join(inline(l) for l in rblock), S["right"]))
            rblock = []
        if para:
            style = S["contact"] if state["after_title"] else S["base"]
            story.append(Paragraph("<br/>".join(inline(l) for l in para), style))
            para = []

    def flush_items():
        nonlocal items
        if items:
            story.append(ListFlowable(
                [ListItem(Paragraph(inline(x), S["bullet"]), leftIndent=11, value="•", bulletFontName=REG)
                 for x in items],
                bulletType="bullet", bulletFontName=REG, bulletFontSize=8.5, leftIndent=11, spaceAfter=3))
            items = []

    for raw in lines:
        line = raw.rstrip()
        if line.startswith("# "):
            flush_para(); flush_items()
            story.append(Paragraph(inline(line[2:]), S["title"]))
            state["after_title"] = True
        elif line.startswith("## "):
            flush_para(); flush_items()
            state["after_title"] = False
            end_header()
            text = line[3:].upper() if t["head_upper"] else line[3:]
            marks.append((len(story), "section"))
            story.append(KeepTogether([
                Paragraph(inline(text), S["section"]),
                HRFlowable(width="100%", thickness=t["rule"], color=colors.HexColor(t["rule_color"]),
                           spaceBefore=1.5, spaceAfter=4),
            ]))
        elif " || " in line and not letter:
            flush_para(); flush_items()
            left, right_text = line.split(" || ", 1)
            marks.append((len(story), "entry"))
            tbl = Table([[Paragraph(inline(left), S["rowl"]), Paragraph(inline(right_text), S["rowr"])]],
                        colWidths=[width * 0.72, width * 0.28])
            tbl.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"),
                                     ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                                     ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 1)]))
            story.append(tbl)
        elif line.startswith("> ") or line == ">":
            flush_items()
            if para: flush_para()
            rblock.append(line[2:])
        elif re.match(r"^\s*[-*]\s+", line):
            flush_para()
            items.append(re.sub(r"^\s*[-*]\s+", "", line))
        elif not line.strip():
            flush_para(); flush_items()
        else:
            flush_items()
            para.append(line)
    flush_para(); flush_items()
    if not letter:
        story = keep_sections_whole(story, marks)
    return story, letter


def keep_sections_whole(story, marks):
    """Never let a section (or a job/degree entry) start on one page and finish on the next.

    Before each section, and before each entry inside it, a conditional page break asks for
    enough room for the whole thing; if it doesn't fit in what's left of the page it moves over.
    """
    width = A4[0] - 2 * 19 * mm - 12
    page_h = A4[1] - 16 * mm - 15 * mm - 12

    import io
    scratch = Canvas(io.BytesIO())

    def height(chunk):
        total = 0
        for f in chunk:
            if isinstance(f, KeepTogether):  # its own wrap() reports a huge sentinel, so measure the parts
                total += height(f._content)
            else:
                total += f.wrapOn(scratch, width, page_h)[1] + f.getSpaceBefore() + f.getSpaceAfter()
        return total

    starts = sorted(marks)
    sec_starts = [i for i, kind in starts if kind == "section"]
    if not sec_starts:
        return story
    bounds = sec_starts + [len(story)]
    sec_end = {a: b for a, b in zip(bounds, bounds[1:])}
    cut_points = sorted(i for i, _ in starts) + [len(story)]
    out, prev = [], 0
    for idx, (i, kind) in enumerate(starts):
        out.extend(story[prev:i])
        if kind == "section":
            need = height(story[i:sec_end[i]])
            if need > page_h:  # longer than a page: at least keep the heading with its first entry
                nxt = cut_points[idx + 2] if idx + 2 < len(cut_points) else len(story)
                need = height(story[i:nxt])
        else:
            nxt = cut_points[idx + 1]
            need = height(story[i:nxt])
        out.append(CondPageBreak(need))
        prev = i
    out.extend(story[prev:])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("out")
    ap.add_argument("--style", default="classic", choices=sorted(THEMES))
    a = ap.parse_args()
    with open(a.src, encoding="utf-8") as f:
        story, letter = build(f.read(), a.style)
    margin = 22 * mm if letter else 19 * mm
    doc = SimpleDocTemplate(a.out, pagesize=A4, leftMargin=margin, rightMargin=margin,
                            topMargin=16 * mm, bottomMargin=15 * mm, title="", author="")
    def footer(canvas, d):
        if not letter and d.page > 1:
            canvas.saveState()
            canvas.setFont(REG, 8.5)
            canvas.setFillColor(colors.HexColor("#555555"))
            canvas.drawRightString(A4[0] - margin, 9 * mm, f"Orlaith Doyle  ·  CV  ·  page {d.page}")
            canvas.restoreState()
    doc.build(story, onFirstPage=footer, onLaterPages=footer, canvasmaker=partial(Canvas, initialFontName=REG))
    pages = doc.page
    print(f"wrote {a.out} ({pages} page{'s' if pages != 1 else ''})")
    limit = 1 if letter else 2
    if pages > limit:
        sys.exit(f"TOO LONG: {pages} pages, limit is {limit}. Shorten the text and render again.")


if __name__ == "__main__":
    main()
