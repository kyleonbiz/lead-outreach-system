#!/usr/bin/env python3
"""Regenerates the PDF test fixtures in supabase/functions/_shared/core/docs/fixtures.

Needs: reportlab, pypdf, Pillow, and (for from-libreoffice.pdf only) LibreOffice (`soffice`).
The committed files are the source of truth for tests; run this only to change them.
"""
import io, os, shutil, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from reportlab.lib.pdfencrypt import StandardEncryption
from pypdf import PdfReader, PdfWriter

OUT = os.path.join(os.path.dirname(__file__), '..', 'supabase', 'functions', '_shared', 'core', 'docs', 'fixtures')
os.makedirs(OUT, exist_ok=True)
W, H = letter
path = lambda n: os.path.join(OUT, n)


def text_page(c, lines, y=H - 90, size=12):
    c.setFont('Helvetica', size)
    for line in lines:
        c.drawString(72, y, line)
        y -= size * 1.6


def raster_text(text):
    img = Image.new('RGB', (900, 260), 'white')
    d = ImageDraw.Draw(img)
    try:
        f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 54)
    except OSError:
        f = ImageFont.load_default()
    d.text((30, 90), text, fill='black', font=f)
    return ImageReader(img)


def image_page(c, text):
    c.drawImage(raster_text(text), 72, H - 330, width=450, height=130)  # pixels only: no text layer


# 1. one page of text
c = canvas.Canvas(path('text-simple.pdf'), pagesize=letter, pageCompression=1)
text_page(c, ['Invoice 1042', 'Customer: Northwind Traders', 'Total due: $1,250.00 by 2026-11-30.'])
c.save()

# 2. three pages, accents and a table-like line
c = canvas.Canvas(path('text-multipage.pdf'), pagesize=letter, pageCompression=1)
text_page(c, ['Master Services Agreement', 'Page one clause: the supplier shall deliver within 14 days.'])
c.showPage()
text_page(c, ['Section 2 - Payment', 'Page two clause: invoices are payable net 30.', 'Item        Qty    Price', 'Widget      4      $45.00'])
c.showPage()
text_page(c, ['Section 3 - Misc', 'Page three clause: Café résumé naïve — signed in Zürich.'])
c.save()

# 3. produced by a real word processor (embedded subset fonts, ToUnicode maps)
if shutil.which('soffice'):
    with tempfile.TemporaryDirectory() as t:
        html = os.path.join(t, 'from-libreoffice.html')
        open(html, 'w').write(
            '<html><body><h1>Service Agreement</h1><p>Payment is due within 30 days. '
            'Café résumé naïve — “quotes”.</p><ul><li>Deliver by Dec 15</li>'
            '<li>Pay within 30 days</li></ul><table border=1><tr><td>Item</td><td>Price</td></tr>'
            '<tr><td>Widget</td><td>$45.00</td></tr></table></body></html>')
        subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', t, html], check=True, capture_output=True, timeout=180)
        shutil.copy(os.path.join(t, 'from-libreoffice.pdf'), path('from-libreoffice.pdf'))
else:
    print('soffice not found: leaving from-libreoffice.pdf as is', file=sys.stderr)

# 4. scanned: a picture of text, no text layer at all
c = canvas.Canvas(path('scanned.pdf'), pagesize=letter)
image_page(c, 'SCANNED CONTRACT')
c.showPage()
image_page(c, 'SIGNED PAGE TWO')
c.save()

# 5. mixed: text, scan, text
c = canvas.Canvas(path('mixed.pdf'), pagesize=letter, pageCompression=1)
text_page(c, ['Cover letter', 'This first page has real text that must be extracted.', 'Attached is a signed scan.'])
c.showPage()
image_page(c, 'SCANNED ATTACHMENT')
c.showPage()
text_page(c, ['Closing page', 'The last page also has real text to extract.'])
c.save()

# 6. password protected
enc = StandardEncryption('open-sesame', 'owner-pw', canPrint=1)
c = canvas.Canvas(path('encrypted.pdf'), pagesize=letter, encrypt=enc)
text_page(c, ['Confidential salary table'])
c.save()

# 7. truncated download
data = open(path('text-multipage.pdf'), 'rb').read()
open(path('corrupt.pdf'), 'wb').write(data[: int(len(data) * 0.6)])

# 8. contains JavaScript: it must never run, and the text must still extract
w = PdfWriter()
w.append(PdfReader(path('text-simple.pdf')))
w.add_js('app.alert("this must never execute"); this.print();')
with open(path('with-javascript.pdf'), 'wb') as f:
    w.write(f)

# 9. more pages than we accept
w = PdfWriter()
for _ in range(301):
    w.add_blank_page(width=200, height=200)
with open(path('too-many-pages.pdf'), 'wb') as f:
    w.write(f)

for n in sorted(os.listdir(OUT)):
    print(f'{os.path.getsize(path(n)):>8}  {n}')
