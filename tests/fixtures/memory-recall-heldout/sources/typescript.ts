export function saveInvoice(invoiceId: string): Promise<unknown> {
	return fetch(`/invoices/${invoiceId}`, { method: 'POST' });
}
