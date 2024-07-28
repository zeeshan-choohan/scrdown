const express = require('express');
const puppeteer = require('puppeteer');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use('/favicon', express.static(path.join(__dirname, 'favicon')));
app.use(express.static(path.join(__dirname)));  // Serve static files from the main directory

const DOWNLOAD_DIR = path.join(__dirname, 'downloadedfile');

// Ensure the download directory exists
fs.mkdir(DOWNLOAD_DIR, { recursive: true }).catch(console.error);

let browser;

// Function to login and save cookies
async function loginAndSaveCookies(page) {
    try {
        await page.goto('https://www.scribd.com/login', { waitUntil: 'networkidle2' });
        await page.waitForSelector('input[name="username"]');
        await page.type('input[name="username"]', process.env.SCRIBD_EMAIL, { delay: 100 });
        await page.waitForSelector('input[name="password"]');
        await page.type('input[name="password"]', process.env.SCRIBD_PASSWORD, { delay: 100 });

        console.log("Please solve the reCAPTCHA manually.");
        await page.waitForSelector('button[type="submit"]');
        await page.click('button[type="submit"]');
        await page.waitForNavigation({ waitUntil: 'networkidle2' });

        const cookies = await page.cookies();
        await fs.writeFile('cookies.json', JSON.stringify(cookies));
        console.log("Login successful and cookies saved.");
    } catch (error) {
        console.error('Error during login and save cookies:', error);
    }
}

// Function to ensure the user is logged in
async function ensureLoggedIn(page) {
    try {
        if (!(await fs.access('cookies.json').then(() => true).catch(() => false))) {
            console.log("Cookies not found, logging in...");
            await loginAndSaveCookies(page);
        } else {
            const cookies = JSON.parse(await fs.readFile('cookies.json', 'utf-8'));
            await page.setCookie(...cookies);
            await page.goto('https://www.scribd.com/', { waitUntil: 'networkidle2' });

            const isLoggedIn = await page.evaluate(() => {
                return document.querySelector('a[href="/logout"]') !== null;
            });

            if (!isLoggedIn) {
                console.log("Cookies are invalid, logging in again...");
                await loginAndSaveCookies(page);
            } else {
                console.log("Cookies are valid, proceeding...");
            }
        }
    } catch (error) {
        console.error('Error during login:', error);
        throw error;
    }
}

// Function to handle document download
async function downloadDocument(page, url) {
    console.log(`Navigating to URL: ${url}`);
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
        console.log(`Navigated to URL: ${url}`);

        await new Promise(resolve => setTimeout(resolve, 15000)); // Wait for 15 seconds
        console.log('Waiting for the download button to appear...');
        await page.waitForSelector("div[class='doc_actions'] span[class='icon icon-ic_download_with_line']", { visible: true, timeout: 120000 });
        console.log('Clicking the download button...');
        await page.evaluate(() => {
            const button = document.querySelector("div[class='doc_actions'] span[class='icon icon-ic_download_with_line']");
            if (button) {
                button.click();
            } else {
                console.log('Download button not found.');
            }
        });

        await new Promise(resolve => setTimeout(resolve, 5000)); // Additional wait for the modal to appear
        console.log('Waiting for the download modal to appear...');
        await page.waitForFunction(() => {
            return document.querySelector('.wrapper__filled-button.download_selection_btn') !== null;
        }, { timeout: 120000 });
        console.log('Download modal appeared.');

        // Prevent the modal from closing
        await page.evaluate(() => {
            const modal = document.querySelector(".modal");
            if (modal) {
                const observer = new MutationObserver(() => {
                    if (modal.style.display === 'none') {
                        modal.style.display = 'block';
                    }
                });
                observer.observe(modal, { attributes: true, attributeFilter: ['style'] });
                console.log('Modal close function overridden.');
            }
        });

        // Ensure the modal remains open
        await page.waitForSelector('.wrapper__filled-button.download_selection_btn', { visible: true, timeout: 120000 });
        console.log('Clicking the download selection button...');
        await page.click('.wrapper__filled-button.download_selection_btn');
        await new Promise(resolve => setTimeout(resolve, 5000)); // Additional wait for the modal to appear

        // Remove request interception to allow download
        await page.setRequestInterception(false);

        // Wait for the download to complete and identify the file
        const filePath = await new Promise((resolve, reject) => {
            const interval = setInterval(async () => {
                try {
                    const files = await fs.readdir(DOWNLOAD_DIR);
                    const downloadedFile = files.find(file => !file.endsWith('.crdownload'));
                    if (downloadedFile) {
                        clearInterval(interval);
                        resolve(path.join(DOWNLOAD_DIR, downloadedFile));
                    }
                } catch (err) {
                    reject(err);
                }
            }, 1000);
        });

        console.log('File downloaded:', filePath);
        return filePath;

    } catch (error) {
        console.error('Error during document download:', error);
        throw error;
    }
}

// API endpoint to handle the download request
app.post('/download', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).send('URL is required');
    }

    let page;

    try {
        if (!browser) {
            browser = await puppeteer.launch({ headless: true });
        }

        page = await browser.newPage();

        // Set download behavior using modern Puppeteer API
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: DOWNLOAD_DIR,
        });

        await ensureLoggedIn(page);

        const filePath = await downloadDocument(page, url);

        // Serve the file to the user
        const fileBuffer = await fs.readFile(filePath);

        const fileType = path.extname(filePath).substring(1); // Extract file type
        res.setHeader('Content-Disposition', `attachment; filename=${path.basename(filePath)}`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(fileBuffer);

        // Delete the file after sending it to the user
        await fs.unlink(filePath);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('An error occurred');
    } finally {
        if (page) await page.close();
    }
});

// Schedule cleanup every hour
cron.schedule('0 * * * *', async () => {
    try {
        const files = await fs.readdir(DOWNLOAD_DIR);
        for (const file of files) {
            const filePath = path.join(DOWNLOAD_DIR, file);
            const stats = await fs.stat(filePath);
            const now = Date.now();
            const endTime = new Date(stats.ctime).getTime() + 3600000; // 1 hour

            if (now > endTime) {
                await fs.unlink(filePath);
                console.log(`File ${filePath} deleted.`);
            }
        }
    } catch (err) {
        console.error('Error during cleanup:', err);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
