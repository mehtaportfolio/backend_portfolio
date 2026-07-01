

import dotenv from "dotenv";
import puppeteer from "puppeteer-core";

dotenv.config();

let chromium = null;

try {
    const module = await import("@sparticuz/chromium");
    chromium = module.default;
} catch (error) {
    chromium = null;
}

async function launchBrowser() {
    console.log("Launching browser...");

    const isProduction = (process.env.NODE_ENV === "production" || process.env.RENDER) && process.platform !== "win32";
    console.log(
    `Running in ${isProduction ? "PRODUCTION (Headless)" : "LOCAL (Headed)"} mode`
);
    const localChromePath = process.env.CHROME_PATH || (process.platform === "win32"
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : "/usr/bin/google-chrome");

    const launchOptions = {
        executablePath: isProduction && chromium
            ? await chromium.executablePath()
            : localChromePath,
        headless: isProduction ? true : false,
        defaultViewport: isProduction && chromium ? chromium.defaultViewport : { width: 1366, height: 768 },
        ignoreHTTPSErrors: true,
        args: isProduction && chromium
            ? [
                ...chromium.args,
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-blink-features=AutomationControlled"
            ]
            : ["--start-maximized", "--disable-blink-features=AutomationControlled"],
        slowMo: 20,
        protocolTimeout: 180000
    };

    const browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1366, height: 768 });

    return { browser, page };
}

async function clickByText(page, text) {
    return page.evaluate((searchText) => {
        const normalized = searchText.toLowerCase();
        const elements = [...document.querySelectorAll("label, button, span, div, a, input")];

        for (const element of elements) {
            const textContent = (element.innerText || element.textContent || "").trim();
            if (!textContent || !textContent.toLowerCase().includes(normalized)) {
                continue;
            }

            const interactiveElement = element.matches("input, button, a, select, textarea")
                ? element
                : element.querySelector("input, button, a, select, textarea");

            if (interactiveElement) {
                interactiveElement.click();
                return true;
            }

            element.click();
            return true;
        }

        return false;
    }, text);
}

async function handleDisclaimer(page) {
    console.log("Checking for disclaimer...");

    // Give the modal time to appear
    await new Promise(resolve => setTimeout(resolve, 3000));

    const disclaimerExists = await page.evaluate(() => {
        return document.body.innerText.includes("Disclaimer");
    });

    if (!disclaimerExists) {
        console.log("No disclaimer found.");
        return false;
    }

    console.log("Disclaimer detected.");

    // Click ACCEPT radio
    const acceptClicked = await page.evaluate(() => {
        const labels = [...document.querySelectorAll("label")];

        const accept = labels.find(l =>
            l.innerText.trim().startsWith("ACCEPT")
        );

        if (!accept) return false;

        accept.click();

        return true;
    });

    console.log("Accept clicked:", acceptClicked);

    await new Promise(resolve => setTimeout(resolve, 500));

    // Click PROCEED button
    const proceedClicked = await page.evaluate(() => {

        const elements = [
            ...document.querySelectorAll("button"),
            ...document.querySelectorAll("input[type='button']"),
            ...document.querySelectorAll("input[type='submit']")
        ];

        const proceed = elements.find(el => {
            const txt = (el.innerText || el.value || "").trim().toUpperCase();
            return txt === "PROCEED";
        });

        if (!proceed) return false;

        proceed.click();

        return true;
    });

    console.log("Proceed clicked:", proceedClicked);

// Wait until the Email input becomes visible and usable
await page.waitForSelector('input[placeholder="Email"]', {
    visible: true,
    timeout: 10000
});

console.log("CAS form is ready.");

    return true;

await page.screenshot({
    path: "screenshots/after_disclaimer.png",
    fullPage: true
});

console.log("Saved screenshot after disclaimer.");

}


async function selectStatementType(page) {
    console.log("Selecting Detailed statement type...");

    await page.waitForSelector('mat-radio-button[value="detailed"]', {
        visible: true,
        timeout: 10000
    });

    const alreadySelected = await page.$eval(
        'mat-radio-button[value="detailed"]',
        el => el.classList.contains("mat-radio-checked")
    );

    if (alreadySelected) {
        console.log("Detailed statement already selected.");
        return;
    }

    await page.click('mat-radio-button[value="detailed"]');

    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log("Detailed statement selected.");
}

async function selectSpecificPeriod(page) {

    console.log("Selecting Specific Period...");

    await page.waitForSelector('mat-radio-button[value="SP"]', {
        visible: true,
        timeout: 10000
    });

    const radio = await page.$('mat-radio-button[value="SP"]');

    if (!radio)
        throw new Error("Specific Period radio not found");

    // scroll into view
    await radio.evaluate(el => el.scrollIntoView({
        behavior: "instant",
        block: "center"
    }));

    // click exactly in the center like a human
    const box = await radio.boundingBox();

    await page.mouse.click(
        box.x + box.width / 2,
        box.y + box.height / 2
    );

    // give Angular time
    await new Promise(r => setTimeout(r,1000));

    // verify
    const checked = await page.$eval(
        'mat-radio-button[value="SP"]',
        el => el.classList.contains("mat-radio-checked")
    );

    console.log("SP checked =", checked);

    if (!checked)
        throw new Error("Specific Period could not be selected.");

    console.log("Specific Period selected.");
}


async function fillDates(page) {

    console.log("Selecting From Date...");

    // Open FROM DATE calendar
    const toggles = await page.$$('mat-datepicker-toggle button');

    if (!toggles[0]) {
        throw new Error("Date picker toggle not found.");
    }

    await toggles[0].click();

    await page.waitForSelector('.mat-calendar-body-cell-content', {
        visible: true,
        timeout: 10000
    });

    const now = new Date();
    const expectedMonthIndex = now.getMonth();
    const expectedYear = now.getFullYear();

    for (let attempt = 0; attempt < 24; attempt += 1) {
        const monthState = await page.evaluate(() => {
            const header = document.querySelector('.mat-calendar-header');
            const text = (header?.innerText || '').trim();
            const match = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);

            if (!match) {
                return { monthIndex: null, year: null };
            }

            const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            const monthIndex = monthNames.findIndex(month => month.toLowerCase() === match[1].toLowerCase());

            return {
                monthIndex,
                year: parseInt(match[2], 10)
            };
        });

        if (monthState.monthIndex === expectedMonthIndex && monthState.year === expectedYear) {
            break;
        }

        const monthDiff = (monthState.year - expectedYear) * 12 + (monthState.monthIndex - expectedMonthIndex);
        const control = monthDiff < 0
            ? await page.$('.mat-calendar-next-button')
            : await page.$('.mat-calendar-previous-button');

        if (!control) {
            throw new Error("Calendar navigation control not found.");
        }

        await control.click();
        await new Promise(resolve => setTimeout(resolve, 400));
    }

    await page.evaluate(() => {
        const dayOne = [...document.querySelectorAll('td.mat-calendar-body-cell')].find((cell) => {
            if (cell.classList.contains('mat-calendar-body-disabled')) {
                return false;
            }

            const content = cell.querySelector('.mat-calendar-body-cell-content');
            return content && content.textContent.trim() === '1';
        });

        if (!dayOne) {
            throw new Error("Current month's day 1 not found.");
        }

        dayOne.click();
    });

    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log("From Date selected.");

    await page.screenshot({
        path: "screenshots/from_date_selected.png",
        fullPage: true
    });

}

async function fillPasswordFields(page, password) {
    const inputHandles = await page.$$('input');
    const passwordFields = [];

    for (const inputHandle of inputHandles) {
        const info = await inputHandle.evaluate((element) => {
            const fieldName = [
                element.name,
                element.id,
                element.placeholder,
                element.getAttribute('formcontrolname'),
                element.getAttribute('aria-label')
            ].join(' ').toLowerCase();

            const isPasswordLike = element.type === 'password' || /password|confirm|reenter|repeat/.test(fieldName);
            const rect = element.getBoundingClientRect();
            const isVisible = !!(rect.width || rect.height) && window.getComputedStyle(element).visibility !== 'hidden';

            return {
                isPasswordLike,
                isVisible
            };
        });

        if (info.isPasswordLike && info.isVisible) {
            passwordFields.push(inputHandle);
        }
    }

    for (const inputHandle of passwordFields) {
        await inputHandle.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await inputHandle.type(String(password), { delay: 50 });
        await inputHandle.evaluate((element) => {
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            element.dispatchEvent(new Event('blur', { bubbles: true }));
        });
    }

    return passwordFields.length;
}

async function fillCredentials(page, credentials) {
    console.log("Filling credentials...");

    const email = (credentials.email || "").trim();
    const rawPassword = (credentials.password || "").trim();

if (!email || !rawPassword) {
    throw new Error("Missing email or password.");
}

    const normalizePassword = (value) => {
        let candidate = (value || "").trim();
        candidate = candidate.replace(/[^A-Za-z0-9@#$*_]/g, "");

        if (candidate.length < 6) {
            candidate = `${candidate}12`;
        }

        if ((candidate.match(/\d/g) || []).length < 2) {
            candidate = `${candidate}12`;
        }

        if (!/[@#$*_]/.test(candidate)) {
            candidate = `${candidate}@`;
        }

        return candidate;
    };

    const password = normalizePassword(rawPassword);

    await page.waitForSelector('input[placeholder="Email"]', { timeout: 10000 });

const fillField = async (selectors, value) => {
    const selectorList = Array.isArray(selectors) ? selectors : [selectors];

    for (const selector of selectorList) {
        const element = await page.$(selector);

        if (!element) {
            continue;
        }

        await element.click({ clickCount: 3 });
        await page.keyboard.press("Backspace");
        await element.type(String(value), { delay: 50 });

        const entered = await page.$eval(selector, el => el.value);

        if (entered === String(value)) {
            console.log(`Filled ${selector} = ${entered}`);
            return;
        }
    }

    throw new Error(`Unable to fill field: ${selectorList.join(", ")}`);
};

    await fillField(['input[placeholder="Email"]', 'input[formcontrolname="email_id"]', 'input[formcontrolname="email"]', 'input[ngmodel][type="text"]'], email);

    const filledPasswordFields = await fillPasswordFields(page, password);

    await new Promise((resolve) => setTimeout(resolve, 700));

  await page.screenshot({
    path: "screenshots/credentials_filled.png",
    fullPage: true
});

console.log("Saved credentials screenshot.");

    const fieldSnapshot = await page.evaluate(() => {
        const inputs = [...document.querySelectorAll('input')];
        const passwordLike = inputs.filter((input) => {
            const fieldName = [
                input.name,
                input.id,
                input.placeholder,
                input.getAttribute('formcontrolname'),
                input.getAttribute('aria-label')
            ].join(' ').toLowerCase();
            return input.type === 'password' || /password|confirm|reenter|repeat/.test(fieldName);
        });

        return {
            email: document.querySelector('input[placeholder="Email"]')?.value || "",
            password: passwordLike[0]?.value || "",
            confirm: passwordLike[1]?.value || ""
        };
    });

    console.log("Credentials populated from environment variables:", fieldSnapshot);
    console.log(`Password fields filled via typing: ${filledPasswordFields}`);
}

async function submitForm(page) {
    console.log("Submitting form...");

    // Find the Submit button
    const buttons = await page.$$("button");

    let submitButton = null;

    for (const btn of buttons) {
        const text = await btn.evaluate(el =>
            (el.innerText || "").trim().toLowerCase()
        );

        if (text === "submit") {
            submitButton = btn;
            break;
        }
    }

    if (!submitButton) {
        throw new Error("Submit button not found.");
    }

    // Scroll into view
    await submitButton.evaluate(el =>
        el.scrollIntoView({
            block: "center"
        })
    );

    await new Promise(resolve => setTimeout(resolve, 500));

    // Click only once
    await submitButton.click();

    console.log("Submit button clicked.");

    // Wait for the success message instead of using a fixed delay
    await page.waitForFunction(() => {
        const text = document.body.innerText || "";
        return (
            text.includes("Your CAS-CAMS") ||
            text.includes("registered email") ||
            text.includes("reference number")
        );
    }, {
        timeout: 60000,
        polling: 500
    });
}

async function extractPageMessage(page) {
    return page.evaluate(() => {
        const bodyText = document.body.innerText || "";
        const lines = bodyText
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((line) => line.length > 4);

        const preferredMessage = lines.find((line) => /success|generated|submitted|error|invalid|incorrect|please enter|captcha|failed/i.test(line));
        return preferredMessage || bodyText.trim().slice(0, 1000);
    });
}

async function waitForSuccess(page) {
    console.log("Waiting for success page...");

    try {
        // Wait until either the success text appears or the URL/page changes.
        await page.waitForFunction(() => {
            const text = document.body.innerText || "";

            return (
                text.includes("Your CAS-CAMS") ||
                text.includes("will be sent to your registered email") ||
                text.includes("reference number") ||
                /\bSuccess\b/i.test(text)
            );
        }, {
            timeout: 60000,
            polling: 500
        });

    } catch (err) {
        console.log("Success page was not detected within 60 seconds.");
    }

    // Give Angular a moment to finish rendering.
    await new Promise(resolve => setTimeout(resolve, 2000));

    const body = await page.evaluate(() => document.body.innerText || "");

    console.log("========== FINAL PAGE ==========");
console.log(body);
console.log("================================");

    const success =
        body.includes("Your CAS-CAMS") &&
        body.includes("registered email");

    if (success) {
        const refMatch = body.match(/CP\d+/i);

console.log("Returning SUCCESS from waitForSuccess()");

        return {
            success: true,
            message: "Statement generated successfully.",
            referenceNumber: refMatch ? refMatch[0] : null
        };
    }

    // Extract the most relevant error line if available.
    const lines = body
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    const errorLine =
        lines.find(line =>
            /please enter|invalid|incorrect|captcha|failed|error/i.test(line)
        ) || body;

console.log("Returning FAILURE from waitForSuccess()");

    return {
        success: false,
        message: errorLine
    };
}



function formatDate(date, pattern) {
    if (pattern === "DD/MM/YYYY") {
        const day = String(date.getDate()).padStart(2, "0");
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const year = date.getFullYear();
        return `${day}/${month}/${year}`;
    }

    const day = String(date.getDate()).padStart(2, "0");
    const month = date.toLocaleString("en-US", { month: "short" });
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
}

async function generateCAS(credentials) {
    console.log("========================================");
    console.log("Starting CAMS Automation...");
    console.log("========================================");

    let browser;
    let page;

    try {
        const launchedBrowser = await launchBrowser();
        browser = launchedBrowser.browser;
        page = launchedBrowser.page;

        console.log("Opening CAMS website...");
        await page.goto("https://www.camsonline.com/Investors/Statements/Consolidated-Account-Statement", {
            waitUntil: "domcontentloaded",
            timeout: 60000
        });
        await page.waitForSelector("body", { timeout: 30000 });
        console.log("Website loaded successfully.");

        await handleDisclaimer(page);

        await new Promise(resolve => setTimeout(resolve, 1000));
        await selectStatementType(page);
        await selectSpecificPeriod(page);
        await fillDates(page);

if (!credentials?.email || !credentials?.password) {
    throw new Error("Missing email or password.");
}

await fillCredentials(page, credentials);

        await submitForm(page);	

        const result = await waitForSuccess(page);
        console.log("generateCAS result:", result);
        return result;
    }  catch (error) {
    console.error("Unexpected error during CAMS automation:", error.message);

    return {
        success: false,
        message: error.message
    };
}

finally {
    if (browser) {
        await browser.close();
    }
}

}

export { generateCAS };