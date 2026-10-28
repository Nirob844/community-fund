import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminDir = path.resolve(__dirname, "../public/assets/js/admin");
const files = fs.readdirSync(adminDir).filter(f => f.endsWith(".js")).map(f => path.join(adminDir, f));
files.push(path.resolve(__dirname, "../public/assets/js/admin.js"));

let hasError = false;

for (const filePath of files) {
  const content = fs.readFileSync(filePath, "utf8");
  const relFile = path.relative(__dirname, filePath);
  
  // Find all named imports: import { a, b, c } from "..."
  const lines = content.split("\n");
  for (const line of lines) {
    const m = line.match(/import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/);
    if (!m) continue;
    const [, namedImports, importPath] = m;
    if (importPath.startsWith("http")) continue;
    
    const targetPath = path.resolve(path.dirname(filePath), importPath);
    let targetMod;
    try {
      targetMod = await import("file:///" + targetPath.replace(/\\/g, "/"));
    } catch (e) {
      console.error(`[FAIL] ${relFile}: Cannot resolve ${importPath}: ${e.message}`);
      hasError = true;
      continue;
    }
    
    const ids = namedImports.split(",").map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    for (const id of ids) {
      if (!(id in targetMod)) {
        console.error(`[FAIL] ${relFile}: '${id}' is NOT exported by '${importPath}'`);
        hasError = true;
      }
    }
  }
}

if (!hasError) {
  console.log("SUCCESS: All imports and exports in all admin modules are 100% matched!");
} else {
  process.exit(1);
}
