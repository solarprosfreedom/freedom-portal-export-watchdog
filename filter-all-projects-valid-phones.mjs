import fs from "node:fs/promises";
import path from "node:path";

const directory = path.join(process.cwd(), "outputs", "freedom_all_projects");
const inputPath = path.join(directory, "FreedomPortal_All_Projects.csv");
const outputPath = path.join(directory, "All Projects with Phone Numbers.csv");

function clean(value) {
  return String(value ?? "").trim();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          value += '"';
          index += 1;
        } else quoted = false;
      } else value += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (character !== "\r") value += character;
  }
  if (row.length || value.length) rows.push([...row, value]);
  return rows;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function validatePhone(value) {
  const raw = clean(value);
  if (!raw) return { valid: false, reason: "empty" };

  const extensionMatch = raw.match(/\s*(?:x|ext\.?|extension)\s*(\d{1,6})\s*$/i);
  const extension = extensionMatch?.[1] || "";
  const base = extensionMatch ? raw.slice(0, extensionMatch.index).trim() : raw;
  if (/[A-Za-z@]/.test(base)) return { valid: false, reason: "contains text" };

  let digits = base.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return { valid: false, reason: "not 10 US digits" };
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return { valid: false, reason: "invalid NANP structure" };
  if (/^(\d)\1{9}$/.test(digits)) return { valid: false, reason: "repeated placeholder digits" };
  if (["1234567890", "0987654321", "1231231234"].includes(digits)) {
    return { valid: false, reason: "placeholder sequence" };
  }
  const exchange = digits.slice(3, 6);
  const subscriber = Number(digits.slice(6));
  if (exchange === "555" && subscriber >= 100 && subscriber <= 199) {
    return { valid: false, reason: "fictional 555 number" };
  }

  const normalized = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}${extension ? ` x${extension}` : ""}`;
  return { valid: true, normalized };
}

const rows = parseCsv(await fs.readFile(inputPath, "utf8"));
const headers = rows.shift();
const phoneIndex = headers.findIndex(header => clean(header).toLowerCase() === "customer phone");
if (phoneIndex < 0) throw new Error("Missing Customer Phone column.");

const reasonCounts = {};
const outputRows = [headers];
for (const row of rows) {
  const result = validatePhone(row[phoneIndex]);
  if (!result.valid) {
    reasonCounts[result.reason] = (reasonCounts[result.reason] || 0) + 1;
    continue;
  }
  row[phoneIndex] = result.normalized;
  outputRows.push(row);
}

const temporary = `${outputPath}.tmp`;
const csv = `${outputRows.map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
await fs.writeFile(temporary, csv, "utf8");
await fs.rename(temporary, outputPath);

const verified = parseCsv(await fs.readFile(outputPath, "utf8"));
if (verified.length !== outputRows.length) throw new Error("Filtered CSV verification failed.");

console.log(JSON.stringify({
  inputRows: rows.length,
  validPhoneRows: outputRows.length - 1,
  excludedRows: rows.length - (outputRows.length - 1),
  reasonCounts,
  outputPath,
}, null, 2));
