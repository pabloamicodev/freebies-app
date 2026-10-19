// Cart prompt asset: the "free gift unlocked" button for the theme's cart drawer and the cart page, and the checkout reminder.
// The main bundle requests it only once an evaluation returns a gift picker, so other pages never load it.
import { initGiftPrompt } from "./widgets/gift-prompt.js";

initGiftPrompt();
