import puppeteer, { Page } from "puppeteer";
import { S3 } from "aws-sdk";
import 'dotenv/config'


interface ScrapeData {
  title: string;
  url: string;
  children?: ScrapeData[];
}

const s3 = new S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

console.log("AWS_ACCESS_KEY_ID", process.env.AWS_ACCESS_KEY_ID);

const visited = new Set();

const uploadToS3 = async (key: string, data: string) => {
  console.log(`Uploading ${key} to S3 with data ${data}...`);
  try {
    await s3
      .putObject({
        Bucket: "legal-scraper",
        Key: `${key}.txt`, // Adding .txt extension to the key
        Body: data,
      })
      .promise();
  } catch (error) {
    console.error("Error uploading to S3:", error);
  }
};

const scrapePage = async (
  page: Page,
  url: string,
  depth: number = 0
): Promise<ScrapeData[]> => {
  if (depth > 2) {
    return [];
  }

  if (visited.has(url)) {
    return [];
  }

  console.log(`Scraping ${url}...`);
  await page.goto(url);
  visited.add(url);

  // Scrape data from the current page (customize the selector as needed)
  const data: ScrapeData[] = await page.evaluate(() => {
    const currentUrl = window.location.href;
    const items = Array.from(document.querySelectorAll("a")).filter(
      (item) => !item.getAttribute("href")?.startsWith("#")
    );
    return items.map((item) => ({
      title: item.textContent?.trim() || "",
      url: new URL(item.getAttribute("href") || "", currentUrl).href,
    }));
  });

  // Here we add code to scrape content from the page
  const pageContent: string = await page.evaluate(() => {
    const contentElement = document.querySelector(".tab_content"); // Using the correct CSS selector
    return contentElement ? contentElement.textContent || "" : "";
  });

  const s3Key = new URL(url).pathname.substring(1).replace(/\//g, "-"); // Creating file path from URL
  await uploadToS3(s3Key, pageContent); // Uploading content to S3

  // Recursively scrape data from each URL found on the current page
  for (const item of data) {
    if (item.url) {
      const childData = await scrapePage(page, item.url, depth + 1);
      item.children = childData;
    }
  }

  return data;
};

(async () => {
  try {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    // const rootUrl = "https://leginfo.legislature.ca.gov/faces/codes.xhtml";
    const rootUrl =
      "https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=CCP&division=&title=1.&part=1.&chapter=1.&article=";

    // Wait for the elements to be loaded on the page
    await page.goto(rootUrl);
    // await page.waitForSelector("#codestocheader a", { timeout: 5000 });

    // Get all codes and their URLs
    const codesData = await scrapePage(page, rootUrl);

    console.log(JSON.stringify(codesData, null, 2));

    await browser.close();
  } catch (error) {
    console.error("Error:", error);
  }
})();
