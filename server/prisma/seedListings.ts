// The 21 seed listings, shared by the seed (prisma/seed.ts) and the photo
// fetcher (scripts/fetchListingImages.ts). Order matters: a listing's id is
// seedId(201 + its index), so append new ones at the end.
//
// Each listing's photo is client/public/images/<slug>.webp, served by the web
// app at /images/<slug>.webp. photoSearch is the short Pixabay search term the
// fetcher uses, since full titles are too specific to find anything. Its last
// word must be how Pixabay tags the item (e.g. "sweatshirt", not "hoodie").
// When search can't find a good product shot, pixabayId pins one image.

import type { ListingCategory, ListingStatus } from "../src/generated/prisma/client.js";

export type SeedListing = {
  title: string;
  description: string;
  category: ListingCategory;
  priceCents: number;
  /** Index into the seed users. */
  seller: number;
  /** File name (without .webp) of the listing's photo in client/public/images. */
  slug: string;
  photoSearch: string;
  /** A specific Pixabay image to use instead of searching (the number at the end of its page URL). */
  pixabayId?: number;
};

/** Where the web app serves a seed listing's photo (client/public is the site root). */
export const seedPhotoPath = (slug: string) => `/images/${slug}.webp`;

/**
 * What re-running the seed does to a seed listing, given its current status
 * (null if it doesn't exist yet). Only a listing still for sale is refreshed:
 * a reserved, sold or removed one belongs to an order (or its seller) now, and
 * resetting it would put a sold item back on sale or change what a dispute
 * shows was sold.
 */
export function seedListingAction(currentStatus: ListingStatus | null): "create" | "update" | "keep" {
  if (currentStatus === null) return "create";
  return currentStatus === "ACTIVE" ? "update" : "keep";
}

export const SEED_LISTINGS: SeedListing[] = [
  // TEXTBOOKS
  { seller: 0, category: "TEXTBOOKS", priceCents: 4500, title: "Calculus: Early Transcendentals (Stewart, 9th ed.)", description: "Used for MATH 1ZA3/1ZB3. Some highlighting in the first few chapters, otherwise clean.", slug: "calculus-textbook", photoSearch: "math book" },
  { seller: 1, category: "TEXTBOOKS", priceCents: 3000, title: "Campbell Biology, 12th edition", description: "Good condition, no writing inside. Cover has a small crease.", slug: "biology-textbook", photoSearch: "biology book" },
  { seller: 2, category: "TEXTBOOKS", priceCents: 2500, title: "Intro to Algorithms (CLRS), 4th ed.", description: "Hardcover. Bought for a data structures course and barely opened it.", slug: "algorithms-textbook", photoSearch: "programming book" },
  { seller: 3, category: "TEXTBOOKS", priceCents: 1800, title: "Organic Chemistry study guide + solutions manual", description: "Klein, 4th ed. Solutions manual is the full one, not the abridged version.", slug: "chemistry-study-guide", photoSearch: "chemistry book" },
  // ELECTRONICS
  { seller: 4, category: "ELECTRONICS", priceCents: 9000, title: "TI-84 Plus CE graphing calculator", description: "Works perfectly, comes with charging cable. Approved for most exams.", slug: "graphing-calculator", photoSearch: "graphing calculator" },
  { seller: 0, category: "ELECTRONICS", priceCents: 12000, title: "Sony WH-CH720N noise-cancelling headphones", description: "About a year old, battery still lasts all day. Includes case.", slug: "headphones", photoSearch: "headphones" },
  { seller: 1, category: "ELECTRONICS", priceCents: 14000, title: '24" 1080p monitor (Dell)', description: "No dead pixels. HDMI cable included. Pickup near campus.", slug: "computer-monitor", photoSearch: "computer monitor" },
  { seller: 2, category: "ELECTRONICS", priceCents: 3500, title: "Logitech mechanical keyboard", description: "Tactile switches, full size. A couple of keycaps are slightly shiny from use.", slug: "mechanical-keyboard", photoSearch: "keyboard", pixabayId: 886462 },
  // FURNITURE
  { seller: 3, category: "FURNITURE", priceCents: 4000, title: "IKEA desk chair (Markus)", description: "Moving out at the end of term. Adjustable height, mesh back.", slug: "desk-chair", photoSearch: "office chair" },
  { seller: 4, category: "FURNITURE", priceCents: 2500, title: "Small bookshelf, 3 shelves", description: "White, about 1 m tall. Easy to carry, fits in a car back seat.", slug: "bookshelf", photoSearch: "bookcase", pixabayId: 1869616 },
  { seller: 0, category: "FURNITURE", priceCents: 1500, title: "LED desk lamp with USB port", description: "Three brightness levels. Works great for late-night studying.", slug: "desk-lamp", photoSearch: "desk lamp" },
  // CLOTHING
  { seller: 1, category: "CLOTHING", priceCents: 3500, title: "McMaster hoodie, size M", description: "Maroon, worn a handful of times. No stains or pilling.", slug: "hoodie", photoSearch: "sweatshirt" },
  { seller: 2, category: "CLOTHING", priceCents: 6000, title: "Winter parka, men's L", description: "Warm enough for Hamilton winters. Zipper and hood in good shape.", slug: "winter-parka", photoSearch: "winter jacket" },
  { seller: 3, category: "CLOTHING", priceCents: 4000, title: "Running shoes, women's size 8", description: "Lightly used, switched brands. Plenty of tread left.", slug: "running-shoes", photoSearch: "running shoes" },
  // KITCHEN
  { seller: 4, category: "KITCHEN", priceCents: 2000, title: "Mini rice cooker (3-cup)", description: "Perfect for a dorm or a small apartment. Inner pot is non-stick.", slug: "rice-cooker", photoSearch: "rice cooker" },
  { seller: 0, category: "KITCHEN", priceCents: 1200, title: "Electric kettle", description: "1.7 L, auto shut-off. Descaled recently.", slug: "electric-kettle", photoSearch: "electric kettle" },
  { seller: 1, category: "KITCHEN", priceCents: 2500, title: "Pots and pans starter set", description: "Two pots, one frying pan, lids included. Some wear on the pan.", slug: "pots-and-pans", photoSearch: "saucepan" },
  // SPORTS
  { seller: 2, category: "SPORTS", priceCents: 2500, title: "Adjustable dumbbells, pair (up to 10 kg)", description: "Spin-lock style. All plates included.", slug: "dumbbells", photoSearch: "dumbbell", pixabayId: 595529 },
  { seller: 3, category: "SPORTS", priceCents: 18000, title: "Road bike, 54 cm frame", description: "Recently tuned up. Comes with a lock. Some scratches on the frame.", slug: "road-bike", photoSearch: "racing bike", pixabayId: 789648 },
  // OTHER
  { seller: 4, category: "OTHER", priceCents: 1000, title: "Mini fridge thermometer + storage bins bundle", description: "Leftover dorm stuff: 4 stackable bins and a fridge thermometer.", slug: "storage-bins", photoSearch: "storage boxes" },
  // Added Nov 9 in place of a test listing.
  { seller: 0, category: "ELECTRONICS", priceCents: 3500, title: "Arduino starter kit", description: "Uno board, breadboard, jumper wires, sensors and LEDs. Used for one ENG 1P13 project; everything is still in the box.", slug: "arduino-starter-kit", photoSearch: "arduino" },
];
