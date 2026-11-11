CREATE INDEX "bill_po_idx" ON "bills" USING btree ("workspace_id","po_id");--> statement-breakpoint
CREATE INDEX "bill_status_idx" ON "bills" USING btree ("workspace_id","status","bill_date");--> statement-breakpoint
CREATE INDEX "gr_po_idx" ON "goods_receipts" USING btree ("workspace_id","po_id");--> statement-breakpoint
CREATE INDEX "pl_po_idx" ON "purchase_lines" USING btree ("workspace_id","po_id");--> statement-breakpoint
CREATE INDEX "prl_return_idx" ON "purchase_return_lines" USING btree ("workspace_id","return_id");--> statement-breakpoint
CREATE INDEX "sl_doc_idx" ON "sales_lines" USING btree ("workspace_id","doc_id");