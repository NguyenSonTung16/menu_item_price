-- Restore the legacy representation from the authoritative integer column.
ALTER TABLE menu_items
  ADD COLUMN price REAL CHECK (price IS NULL OR price > 0);
UPDATE menu_items SET price = price_vnd / 1000.0;
