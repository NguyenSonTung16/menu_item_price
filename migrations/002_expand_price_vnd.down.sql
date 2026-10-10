-- Safe only after every instance that needs price_vnd has been rolled back.
ALTER TABLE menu_items DROP COLUMN price_vnd;
