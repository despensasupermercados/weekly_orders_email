// Outlook does not send plain HTML. It sends MIME with the html part encoded
// as quoted-printable (or occasionally base64), so `=` becomes `=3D`, `#`
// becomes `=23`, and long lines are broken with soft `=\r\n` wraps that can
// split a tag in half.
//
// Feeding that straight to an HTML parser is silently destructive: a style
// attribute reads `background:=23C6EFCE` instead of `background:#C6EFCE`, the
// green-PO test fails, tags broken across a soft wrap stop matching, and rows
// are either dropped entirely or written with null loading date, month and
// country. Decode first, always.

const CRLF = /\r?\n/;

function decodeQuotedPrintable(s) {
  return s
    .replace(/=\r?\n/g, '') // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function base64Bytes(s) {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean) return new Uint8Array(0);
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function decodeBase64(s) {
  return new TextDecoder('utf-8').decode(base64Bytes(s));
}
// The BYTES of a part, for a workbook attachment. Running an .xlsx through the
// UTF-8 text decoder above replaces every invalid byte with U+FFFD, which is
// why the workbook path could never be wired on `content` alone.
function bodyBytes(head, body) {
  const enc = headerValue(head, 'Content-Transfer-Encoding').toLowerCase();
  if (enc.startsWith('base64')) return base64Bytes(body);
  return new TextEncoder().encode(enc.startsWith('quoted-printable') ? decodeQuotedPrintable(body) : body);
}

function headerValue(head, name) {
  const m = head.match(
    new RegExp(`^${name}\\s*:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, 'im')
  );
  return m ? m[1].replace(CRLF, ' ').trim() : '';
}

function splitHeadBody(part) {
  const i = part.search(/\r?\n\r?\n/);
  if (i < 0) return [part, ''];
  const gap = part.slice(i).match(/^\r?\n\r?\n/)[0].length;
  return [part.slice(0, i), part.slice(i + gap)];
}

function decodeBody(head, body) {
  const enc = headerValue(head, 'Content-Transfer-Encoding').toLowerCase();
  if (enc.startsWith('base64')) return decodeBase64(body);
  if (enc.startsWith('quoted-printable')) return decodeQuotedPrintable(body);
  return body; // 7bit / 8bit / binary / absent
}

// Walks a MIME message, including a multipart/alternative nested inside a
// multipart/mixed, and returns the DECODED text/html part. Falls back to
// text/plain, then to the whole decoded body.
// SPLIT A MULTIPART BODY INTO ITS PARTS. ONE DEFINITION, TWO CALLERS.
//
// htmlPartOf and attachmentsOf each carried their own copy of this line, and
// each copy carried the same bug — which is the argument for it living here.
//
// THE BUG: RFC 2046 lets the final `--boundary--` be the last thing in the
// message, with no trailing CRLF, and real senders do exactly that. The old
// pattern required a newline AFTER the delimiter, so that closing marker never
// split. It stayed glued to the end of the last part's body.
//
// It did not throw, which would have been the kind outcome. base64Bytes strips
// every character outside the base64 alphabet, so a trailing `--X_BOUND_1--`
// quietly became `XBOUND1`, was appended to the payload, and decoded into FIVE
// EXTRA BYTES on the end of the attachment. Measured 22 Sep 2026: a CSV of
// "ship,qty / Allure,4" came back with four junk bytes and an `=` glued on.
// A corrupt final row in an Ordering Schedule, or a corrupt zip inside an
// .xlsx, out of a message that is perfectly legal — and nothing anywhere
// would have said so. In htmlPartOf the same fault corrupts the tail of the
// HTML, which is where the Azamara MLS table is read from.
//
// End of input terminates a part too. The empty tail that produces is dropped.
export function mimeParts(body, boundary) {
  const esc = String(boundary).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(body).split(new RegExp(`--${esc}(?:--)?(?:\\r?\\n|$)`)).filter(Boolean);
}

export function htmlPartOf(raw) {
  const [head, body] = splitHeadBody(raw);
  const ctype = headerValue(head, 'Content-Type');
  const boundary = (ctype.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i) || [])[1];

  if (!boundary) {
    const decoded = decodeBody(head, body);
    return /text\/plain/i.test(ctype) && !/<t[dr][\s>]/i.test(decoded) ? '' : decoded;
  }

  const parts = mimeParts(body, boundary);
  let html = '';
  let plain = '';
  for (const part of parts) {
    if (!part || !part.trim()) continue;
    const [ph, pb] = splitHeadBody(part);
    const pct = headerValue(ph, 'Content-Type');
    if (/multipart\//i.test(pct)) {
      const nested = htmlPartOf(part);
      if (nested) html = html || nested;
    } else if (/text\/html/i.test(pct)) {
      html = html || decodeBody(ph, pb);
    } else if (/text\/plain/i.test(pct)) {
      plain = plain || decodeBody(ph, pb);
    }
  }
  return html || plain;
}

export const _internals = { decodeQuotedPrintable, decodeBase64, headerValue };

// Attachments, by filename and decoded bytes.
//
// Ray was asked to attach the MLS as an .xlsx as well as pasting it, because
// the attachment keeps the cell colours and colour is data in that file. The
// Worker does not yet parse the workbook - rowsFromWorkbook() exists and takes
// the xlsx library by injection, but no library is bundled - so the honest
// behaviour is to SEE the attachment and say so. An attachment that arrives and
// is silently ignored is the same failure that discarded eighteen ships'
// schedules: the file was there, nothing read it, and nothing said anything.
export function attachmentsOf(raw) {
  const [head, body] = splitHeadBody(raw);
  const ctype = headerValue(head, 'Content-Type');
  const boundary = (ctype.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i) || [])[1];
  if (!boundary) return [];

  const parts = mimeParts(body, boundary);
  const out = [];
  for (const part of parts) {
    if (!part || !part.trim()) continue;
    const [ph, pb] = splitHeadBody(part);
    const pct = headerValue(ph, 'Content-Type');
    if (/multipart\//i.test(pct)) { out.push(...attachmentsOf(part)); continue; }

    const disp = headerValue(ph, 'Content-Disposition');
    const name =
      (disp.match(/filename\s*=\s*"?([^";\r\n]+)"?/i) || [])[1] ||
      (pct.match(/name\s*=\s*"?([^";\r\n]+)"?/i) || [])[1] || '';
    // An inline text/html part is the message, not an attachment.
    const isAttachment = /attachment/i.test(disp) || (name && !/^text\/(html|plain)/i.test(pct));
    if (!isAttachment || !name) continue;

    out.push({
      filename: name.trim(),
      contentType: pct.split(';')[0].trim(),
      // Bytes are decoded but not parsed. Whoever wires the workbook path gets
      // a buffer, not another decoding problem.
      content: decodeBody(ph, pb),
      bytes: bodyBytes(ph, pb),
    });
  }
  return out;
}
