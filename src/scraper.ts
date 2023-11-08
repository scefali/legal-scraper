import puppeteer, { Page } from "puppeteer";
import { S3 } from "aws-sdk";
import * as pdfParse from "pdf-parse";
import "dotenv/config";

const MAX_DEPTH = 100;

interface ScrapeData {
  title: string;
  url: string;
  children?: ScrapeData[];
}

const s3 = new S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const visited = new Set();

const uploadUrlToS3 = async (url: string, data: string) => {
  const urlObj = new URL(url);
  // Include the hostname in the S3 key path
  const s3KeyParts = [urlObj.hostname.replace(/\./g, "-")]; // Replace '.' with '-' to avoid S3 key issues

  // Append the path and query parameters to the base path
  s3KeyParts.push(urlObj.pathname.substring(1).replace(/\/+/g, "/")); // Normalize consecutive slashes to a single slash

  Array.from(urlObj.searchParams)
    .sort()
    .forEach(([param, value]) => {
      if (value) {
        s3KeyParts.push(`${param}=${encodeURIComponent(value)}`);
      }
    });

  // Join all parts to form the final S3 key
  const s3Key = s3KeyParts.join("/");
  console.log({ s3Key, data });
  return uploadToS3(s3Key, data);
};

const uploadToS3 = async (key: string, data: string) => {
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
  rootHostname: string,
  depth: number = 0
): Promise<undefined> => {
  if (depth > MAX_DEPTH) {
    return;
  }

  if (visited.has(url)) {
    return;
  }

  if (!url.startsWith("http")) {
    console.log("skipping", url);
    return;
  }

  console.log(`Scraping ${url}...`);

  const size = visited.size;
  if (size % 100 === 0) {
    console.log("visited", size);
  }

  await page.goto(url);
  visited.add(url);

  // Scrape data from the current page (customize the selector as needed)
  const data: ScrapeData[] = await page.evaluate((rootHostname) => {
    const currentUrl = window.location.href;
    const items = Array.from(document.querySelectorAll("a")).filter((item) => {
      const href = item.getAttribute("href");
      if (!href || href.startsWith("#")) {
        return false;
      }
      const itemUrl = new URL(href, currentUrl);
      return itemUrl.hostname === rootHostname; // Check if the link's domain matches the root domain
    });
    return items.map((item) => ({
      title: item.textContent?.trim() || "",
      url: new URL(item.getAttribute("href") || "", currentUrl).href,
    }));
  }, rootHostname);

  // Get the page content if you need to scrape the content of each page
  const pageContent: string = await page.evaluate(() => {
    const contentElement = document.querySelector(".tab_content"); // Use the correct CSS selector for your content
    return contentElement ? contentElement.textContent || "" : "";
  });

  // Upload page content to S3
  if (pageContent) {
    await uploadUrlToS3(url, pageContent);
  }

  // Recursively scrape data from each URL found on the current page
  for (const item of data) {
    if (item.url.toLowerCase().endsWith(".pdf")) {
      // Fetch the PDF file
      const pdfResponse = await fetch(item.url);
      const pdfBuffer = await pdfResponse.arrayBuffer();

      // Parse the PDF file
      const pdfData = await pdfParse(Buffer.from(pdfBuffer));
      console.log(pdfData.text);

      // Upload parsed text to S3
      await uploadUrlToS3(item.url, pdfData.text);
    } else {
      // If the URL is not a PDF, handle it as you did before
      if (item.url) {
        const childData = await scrapePage(
          page,
          item.url,
          rootHostname,
          depth + 1
        );
        item.children = childData;
      }
    }
  }
};

(async () => {
  try {
    // Read the base URL from the command-line arguments
    let rootUrl = process.argv[2]; // The first argument is the node executable, the second is the script name, the third is the first user argument

    // If no URL is provided, use the default URL
    if (!rootUrl) {
      rootUrl = "https://leginfo.legislature.ca.gov/faces/codes.xhtml";
    }

    // Validate the provided URL
    try {
      new URL(rootUrl);
    } catch (error) {
      console.error("The provided base URL is invalid.");
      process.exit(1); // Exit if the URL is invalid
    }

    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    // Wait for the elements to be loaded on the page
    await page.goto(rootUrl);
    // await page.waitForSelector("#codestocheader a", { timeout: 5000 });

    const rootHostname = new URL(rootUrl).hostname;

    // Get all codes and their URLs
    await scrapePage(page, rootUrl, rootHostname);

    await browser.close();
  } catch (error) {
    console.error("Error:", error);
  }
})();
