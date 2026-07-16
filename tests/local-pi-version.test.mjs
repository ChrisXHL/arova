import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findPi } from "../src/local-env.ts";

const cli = findPi();
const pkg = JSON.parse(readFileSync(join(dirname(dirname(cli)), "package.json"), "utf8"));
if (pkg.version !== "0.80.2" || !cli.includes("goal-mode-pi/node_modules")) {
  throw new Error(`执行端仍可能使用错误的全局 pi：${pkg.version} ${cli}`);
}
console.log(`✅ 执行端版本锁定：使用随应用打包的 pi ${pkg.version}`);
