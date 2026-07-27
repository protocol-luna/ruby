const https = require("https");
const fs = require("fs");
const path = require("path");

const ORDERS = {
  2: "chain-order2.db",
  3: "chain-order3.db",
  4: "chain-order4.db",
};

const order = parseInt(process.argv[2] || "4", 10);
const filename = ORDERS[order];
if (!filename) {
  console.error(`Usage: node tools/download-chain.cjs [2|3|4]`);
  process.exit(1);
}

const dest = path.join(__dirname, "..", "chain.db");
const url = `https://huggingface.co/fox3000foxy/ruby-chain/resolve/main/${filename}`;

function download(url) {
  const file = fs.createWriteStream(dest);
  https.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      file.close();
      fs.unlinkSync(dest);
      download(res.headers.location);
      return;
    }
    if (res.statusCode !== 200) {
      console.error(`  HTTP ${res.statusCode}: ${res.statusMessage}`);
      file.close();
      fs.unlinkSync(dest);
      process.exit(1);
    }
    const total = parseInt(res.headers["content-length"] || "0", 10);
    let received = 0;
    console.log(`Downloading ${filename} (order ${order})...`);
    res.on("data", (chunk) => {
      received += chunk.length;
      if (total) {
        const pct = ((received / total) * 100).toFixed(1);
        process.stdout.write(`\r  ${(received / 1024 / 1024).toFixed(0)} MB / ${(total / 1024 / 1024).toFixed(0)} MB (${pct}%)`);
      } else {
        process.stdout.write(`\r  ${(received / 1024 / 1024).toFixed(0)} MB`);
      }
    });
    res.pipe(file);
    file.on("finish", () => {
      console.log(`\n  Saved to chain.db (${(fs.statSync(dest).size / 1024 / 1024).toFixed(0)} MB)`);
    });
  }).on("error", (err) => {
    console.error(`  Error: ${err.message}`);
    try { fs.unlinkSync(dest); } catch {}
    process.exit(1);
  });
}

download(url);
