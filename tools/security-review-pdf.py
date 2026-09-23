#!/usr/bin/env python3
"""security-review-pdf.py — render security.md to the published PDF.

Usage:  python3 tools/security-review-pdf.py [security.md] [out.pdf]
Defaults: security.md → ../website/Keylay_Security_Review_v<N>.pdf, where <N>
is read from the first heading ("# Security Review Summary — v5" → 5).

Plain ReportLab rendering (same toolchain as v4). Handles the Markdown subset
security.md uses: #/##/### headings, paragraphs, "- " bullets, "---" rules,
**bold**, *italic*, `code`, and [text](url) links.
"""
import re, sys, os, html

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer,
                                ListFlowable, ListItem, HRFlowable)

src = sys.argv[1] if len(sys.argv) > 1 else 'security.md'
text = open(src, encoding='utf-8').read()

m = re.search(r'^# .*?v(\d+)\s*$', text, re.M)
ver = m.group(1) if m else 'X'
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
    os.path.dirname(os.path.abspath(src)), '..', 'website', f'Keylay_Security_Review_v{ver}.pdf')

ss = getSampleStyleSheet()
body = ParagraphStyle('body', parent=ss['BodyText'], fontName='Helvetica', fontSize=9.5,
                      leading=13, spaceAfter=6, alignment=TA_LEFT)
meta = ParagraphStyle('meta', parent=body, spaceAfter=1)
h1 = ParagraphStyle('h1', parent=ss['Heading1'], fontName='Helvetica-Bold', fontSize=17, leading=21, spaceAfter=8)
h2 = ParagraphStyle('h2', parent=ss['Heading2'], fontName='Helvetica-Bold', fontSize=13, leading=16, spaceBefore=12, spaceAfter=6)
h3 = ParagraphStyle('h3', parent=ss['Heading3'], fontName='Helvetica-Bold', fontSize=11, leading=14, spaceBefore=10, spaceAfter=4)
bullet = ParagraphStyle('bullet', parent=body, spaceAfter=2)

def inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r'`([^`]+)`', r'<font face="Courier" size="8.5">\1</font>', s)
    s = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', s)
    s = re.sub(r'(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])', r'<i>\1</i>', s)
    s = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2" color="#2563eb">\1</a>', s)
    return s

story = []
para = []
bullets = []

def flush_para():
    global para
    if para:
        story.append(Paragraph(inline(' '.join(para)), body)); para = []

def flush_bullets():
    global bullets
    if bullets:
        story.append(ListFlowable([ListItem(Paragraph(inline(b), bullet), leftIndent=12) for b in bullets],
                                  bulletType='bullet', start='•', leftIndent=14, bulletFontSize=8))
        story.append(Spacer(1, 4)); bullets = []

for raw in text.splitlines():
    line = raw.rstrip()
    if not line.strip():
        flush_para(); flush_bullets(); continue
    if line.startswith('- '):
        flush_para(); bullets.append(line[2:].strip()); continue
    if bullets and line.startswith('  '):
        bullets[-1] += ' ' + line.strip(); continue
    flush_bullets()
    if line.strip() == '---':
        flush_para(); story.append(Spacer(1, 6)); story.append(HRFlowable(width='100%', thickness=0.5, color='#999999')); story.append(Spacer(1, 6)); continue
    if line.startswith('### '):
        flush_para(); story.append(Paragraph(inline(line[4:]), h3)); continue
    if line.startswith('## '):
        flush_para(); story.append(Paragraph(inline(line[3:]), h2)); continue
    if line.startswith('# '):
        flush_para(); story.append(Paragraph(inline(line[2:]), h1)); continue
    if line.startswith('**'):  # '**Label:** value' header lines and finding headers stand alone
        flush_para(); story.append(Paragraph(inline(line), meta if ':**' in line[:40] else body)); continue
    para.append(line.strip())
flush_para(); flush_bullets()

title = re.search(r'^# (.*)$', text, re.M).group(1)
doc = SimpleDocTemplate(out, pagesize=letter, leftMargin=0.9*inch, rightMargin=0.9*inch,
                        topMargin=0.8*inch, bottomMargin=0.8*inch, title=title, author='Keylay')
doc.build(story)
print(out)
