import { expect, test } from "@playwright/test";

test("image generation fits a phone and uses the local authenticated gateway", async ({ page }) => {
  await page.route("**/api/generate", async route => {
    expect(route.request().headers().authorization).toBe("Bearer demo-password");
    expect(route.request().postDataJSON()).toMatchObject({ kind: "image" });
    await route.fulfill({ json: { data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" }] } });
  });
  await page.goto("/");
  await page.getByLabel("Starter password").fill("demo-password");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Completed");
  await expect(page.getByRole("img")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("video polls to completion and offers an authenticated blob download", async ({ page }) => {
  let submits = 0;
  let polls = 0;
  await page.route("**/api/generate**", async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "POST") { submits++; return route.fulfill({ json: { id: "video_123", status: "queued" } }); }
    expect(url.searchParams.get("id")).toBe("video_123");
    if (url.searchParams.has("download")) return route.fulfill({ contentType: "video/mp4", body: Buffer.from([0, 1, 2]) });
    polls++;
    return route.fulfill({ json: { status: polls === 1 ? "in_progress" : "completed" } });
  });
  await page.goto("/");
  await page.getByLabel("Starter password").fill("demo-password");
  await page.getByLabel("Output").selectOption("video");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByRole("link", { name: "Download video" })).toHaveAttribute("href", /^blob:/, { timeout: 15_000 });
  expect(submits).toBe(1); expect(polls).toBe(2);
});

test("failed task stops polling; resume never submits another generation", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/generate**", async route => {
    calls++;
    expect(route.request().method()).toBe("GET");
    await route.fulfill({ json: { status: "failed" } });
  });
  await page.goto("/");
  await page.getByLabel("Starter password").fill("demo-password");
  await page.getByLabel("Video task ID").fill("video_existing");
  await page.getByRole("button", { name: "Resume video" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Video generation failed");
  expect(calls).toBe(1);
});

test("balance error is visible and generation can be retried manually", async ({ page }) => {
  await page.route("**/api/generate", route => route.fulfill({ status: 402, json: { error: "Insufficient TokPort balance." } }));
  await page.goto("/");
  await page.getByLabel("Starter password").fill("demo-password");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Insufficient TokPort balance");
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
});

test("HTML host timeout shows its HTTP status without retrying the submission", async ({ page }) => {
  let submissions = 0;
  await page.route("**/api/generate", route => {
    submissions++;
    return route.fulfill({ status: 504, contentType: "text/html", body: "<html>Gateway timeout</html>" });
  });
  await page.goto("/");
  await page.getByLabel("Starter password").fill("demo-password");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toHaveText("HTTP 504");
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
  expect(submissions).toBe(1);
});
