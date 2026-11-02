import { chromium, firefox, webkit, devices } from "playwright";

const hosts = [
  "https://cloudpid-sandbox-probe-probehotny7vxvrzqdkrkzvvo3jxlxk.ian-g-pascoe.workers.dev",
  "https://sandbox-probe.ianpascoe.dev",
];
const headers = {
  "CF-Access-Client-Id": process.env.PROBE_CLIENT_ID,
  "CF-Access-Client-Secret": process.env.PROBE_CLIENT_SECRET,
};
const configs = [
  ["chromium", chromium, {}],
  ["firefox", firefox, {}],
  ["webkit", webkit, {}],
  ["webkit-iphone", webkit, devices["iPhone 15"]],
];

let failures = 0;
for (const [name, type, options] of configs) {
  const browser = await type.launch();
  for (const host of hosts) {
    const context = await browser.newContext(options);
    // The service token goes to the host only, never to the sandbox.
    await context.route(`${host}/**`, (route) =>
      route.continue({ headers: { ...route.request().headers(), ...headers } }),
    );
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    await page.goto(`${host}/?label=playwright-${name}`);
    await page.waitForFunction(
      () => !document.getElementById("summary").textContent.startsWith("Running"),
      null,
      { timeout: 90_000 },
    );
    await page.waitForFunction(() => document.getElementById("reported").textContent !== "", null, {
      timeout: 10_000,
    });
    const summary = await page.textContent("#summary");
    const rows = await page.$$eval("#out tr", (trs) =>
      trs.map((tr) => [...tr.children].map((td) => td.textContent)),
    );
    console.log(`\n## ${name} · ${host} → ${summary}`);
    for (const [ok, check, detail] of rows)
      if (ok !== "PASS" || process.env.VERBOSE) console.log(`  ${ok} ${check} ${detail}`);
    if (!summary.startsWith("ALL PASS")) failures++;
    if (consoleErrors.length) console.log("  console errors:", consoleErrors.slice(0, 6).join(" | "));
    await page.screenshot({ path: `/tmp/probe-e2e/${name}-${new URL(host).hostname.split(".")[0].slice(0, 20)}.png`, fullPage: true });
    await context.close();
  }
  await browser.close();
}
process.exit(failures ? 1 : 0);
