-- Run only when every instance runs code that reads and writes price_vnd only.
ALTER TABLE menu_items DROP COLUMN price;
