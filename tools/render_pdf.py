"""Turn a simple Markdown CV or cover letter into a PDF set in Times New Roman.

Usage: python3 tools/render_pdf.py input.md output.pdf

Supported Markdown: "# " name/title, "## " section heading, "- " bullets,
**bold**, *italic*, blank lines between paragraphs. A single line break inside
a paragraph is kept as a line break. Lines starting with "> " form a
right-aligned block (used for the sender's details on a cover letter). Requires: pip install reportlab
"""
import re
import sys
from functools import partial

from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import HRFlowable, ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer

# PDF standard Times fonts: shown as Times New Roman on Windows and Times on Mac.
REG, BOLD, ITAL = "Times-Roman", "Times-Bold", "Times-Italic"

base = ParagraphStyle("base", fontName=REG, fontSize=11, leading=14, spaceAfter=6)
title = ParagraphStyle("title", parent=base, fontName=BOLD, fontSize=20, leading=24, alignment=TA_CENTER, spaceAfter=2)
contact = ParagraphStyle("contact", parent=base, fontSize=10, alignment=TA_CENTER, spaceAfter=8)
section = ParagraphStyle("section", parent=base, fontName=BOLD, fontSize=12.5, leading=15, spaceBefore=8, spaceAfter=1)
bullet = ParagraphStyle("bullet", parent=base, spaceAfter=2)
right = ParagraphStyle("right", parent=base, alignment=TA_RIGHT)


def inline(text):
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<i>\1</i>", text)
    return text


# A cover letter (no "# " title) gets a full blank line between blocks, like a typed letter.
letter_base = ParagraphStyle("letter", parent=base, spaceAfter=14)
letter_right = ParagraphStyle("letter_right", parent=letter_base, alignment=TA_RIGHT)


def build(md_text):
    global base, right
    is_letter = not any(l.startswith("# ") for l in md_text.splitlines())
    if is_letter:
        base, right = letter_base, letter_right
    story, para, items, rblock = [], [], [], []
    after_title = False

    def flush_para():
        nonlocal para, after_title, rblock
        if rblock:
            story.append(Paragraph("<br/>".join(inline(l) for l in rblock), right))
            rblock = []
        if para:
            style = contact if after_title else base
            story.append(Paragraph("<br/>".join(inline(l) for l in para), style))
            para, after_title = [], False

    def flush_items():
        nonlocal items
        if items:
            story.append(ListFlowable(
                [ListItem(Paragraph(inline(t), bullet), leftIndent=12, value="•", bulletFontName=REG) for t in items],
                bulletType="bullet", bulletFontName=REG, bulletFontSize=9, leftIndent=12, spaceAfter=4))
            items = []

    for raw in md_text.splitlines():
        line = raw.rstrip()
        if line.startswith("# "):
            flush_para(); flush_items()
            story.append(Paragraph(inline(line[2:]), title))
            after_title = True
        elif line.startswith("## "):
            flush_para(); flush_items()
            story.append(Paragraph(inline(line[3:]), section))
            story.append(HRFlowable(width="100%", thickness=0.6, color="#444444", spaceBefore=1, spaceAfter=4))
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
    return story


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: python3 tools/render_pdf.py input.md output.pdf")
    src, out = sys.argv[1], sys.argv[2]
    with open(src, encoding="utf-8") as f:
        story = build(f.read())
    doc = SimpleDocTemplate(out, pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm,
                            topMargin=16 * mm, bottomMargin=16 * mm, title="", author="")
    doc.build(story, canvasmaker=partial(Canvas, initialFontName=REG))
    print("wrote", out)


if __name__ == "__main__":
    main()
