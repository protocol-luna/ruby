const { execSync } = require("child_process");
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
  console.error("Usage: node tools/download-chain.cjs [2|3|4]");
  process.exit(1);
}

const dest = path.join(__dirname, "..", "chain.db");
const repo = "fox3000foxy/ruby-chain";

function downloadViaHf() {
  console.log(`Downloading ${filename} via hf CLI...`);
  execSync(`hf download ${repo} ${filename} --local-dir .`, {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
  });
  const tmp = path.join(__dirname, "..", filename);
  fs.renameSync(tmp, dest);
  const size = (fs.statSync(dest).size / 1024 / 1024).toFixed(0);
  console.log(`  Saved to chain.db (${size} MB)`);
}

function downloadViaHttps() {
  const https = require("https");

  function download(url) {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        download(res.headers.location);
        return;
      }
      if (res.statusCode !== 200) {
        console.error(`  HTTP ${res.statusCode}: ${res.statusMessage}`);
        file.close();
        try { fs.unlinkSync(dest); } catch {}
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
        process.exit(0);
      });
    }).on("error", (err) => {
      console.error(`  Error: ${err.message}`);
      try { fs.unlinkSync(dest); } catch {}
      process.exit(1);
    });
  }

  const url = `https://huggingface.co/${repo}/resolve/main/${filename}`;
  console.log(`Downloading ${filename} (order ${order})...`);
  download(url);
}

try {
  execSync("hf --version", { stdio: "ignore" });
  downloadViaHf();
} catch {
  downloadViaHttps();
}
