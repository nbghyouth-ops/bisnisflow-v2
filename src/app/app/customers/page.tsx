"use client";
import { useState } from "react";
import { api, Btn, Card, ErrorBox, Field, FormModal, Help, Loading, Modal, Pager, PageHeader, Status, Table, fdate, useApi, useMoney, useToast, useWs } from "@/components/ui";

type C = { id: string; name: string; phone: string | null; email: string | null; group_name: string | null; credit_limit: string; outstanding: string; consent_marketing: boolean };

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const m = useMoney();
  const { data, error } = useApi<{ customer: C & { address: string | null; notes: string | null }; sales: { id: string; number: string; business_date: string; total: string; status: string; outstanding: string }[] }>(`customers/${id}`);
  const ix = useApi<{ items: { id: string; title: string; status: string; due_date: string | null; data: { channel?: string } }[] }>(`records?kind=interaction&search=${encodeURIComponent(data?.customer.name ?? "")}`);
  return (
    <Modal title={data?.customer.name ?? "Pelanggan"} onClose={onClose} wide>
      {error && <ErrorBox message={error} />}{!data && !error && <Loading />}
      {data && (
        <>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted">Telepon</dt><dd>{data.customer.phone ?? "–"}</dd></div><div><dt className="text-muted">Email</dt><dd>{data.customer.email ?? "–"}</dd></div>
            <div><dt className="text-muted">Alamat</dt><dd>{data.customer.address ?? "–"}</dd></div><div><dt className="text-muted">Batas kredit</dt><dd>{m(data.customer.credit_limit)}</dd></div>
            <div><dt className="text-muted">Saldo piutang</dt><dd className="font-semibold">{m(data.sales.reduce((s, x) => s + Number(x.outstanding), 0))}</dd></div><div><dt className="text-muted">Persetujuan pemasaran</dt><dd>{data.customer.consent_marketing ? "Ya" : "Tidak"}</dd></div>
          </dl>
          <h3 className="mb-1 mt-4 text-sm font-semibold">Riwayat pembelian</h3>
          <Table caption="Riwayat pembelian" empty="Belum ada pembelian." rows={data.sales} cols={[{ key: "number", label: "Nomor" }, { key: "business_date", label: "Tanggal", render: (r) => fdate(r.business_date) }, { key: "total", label: "Total", num: true, render: (r) => m(r.total) }, { key: "outstanding", label: "Sisa", num: true, render: (r) => m(r.outstanding) }, { key: "status", label: "Status", render: (r) => <Status value={r.status} /> }]} />
          <h3 className="mb-1 mt-4 text-sm font-semibold">Interaksi</h3>
          <Table caption="Interaksi" empty="Belum ada interaksi tercatat (tambahkan di Pelanggan & Penjualan → Riwayat Interaksi)." rows={ix.data?.items ?? []} cols={[{ key: "title", label: "Ringkasan" }, { key: "channel", label: "Kanal", render: (r) => r.data?.channel ?? "–" }, { key: "status", label: "Status", render: (r) => <Status value={r.status} /> }]} />
        </>
      )}
    </Modal>
  );
}

export default function Customers() {
  const m = useMoney();
  const toast = useToast();
  const { ws, allowed } = useWs();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [modal, setModal] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading, reload } = useApi<{ items: C[] }>(`customers?limit=25&offset=${offset}&search=${encodeURIComponent(search)}`);
  return (
    <>
      <PageHeader title={ws.terms.customer} desc="Profil, riwayat pembelian, saldo piutang, batas kredit, dan persetujuan komunikasi." actions={<>{allowed["crm:write"] && <Btn onClick={() => setModal(true)}>+ Tambah</Btn>}<a className="btn btn-secondary" href="/api/v1/export/customers">Ekspor CSV</a></>} />
      <Help><p>Data pribadi dikelola sesuai UU PDP: catat persetujuan, dan gunakan menu Legal & Privasi untuk permintaan akses, koreksi, ekspor, atau penghapusan data.</p></Help>
      <Card>
        <Field label="Cari nama, telepon, atau email" htmlFor="cs"><input id="cs" className="input max-w-sm" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} /></Field>
        <div className="mt-3">
          {loading && <Loading />}{error && <ErrorBox message={error} onRetry={reload} />}
          {data && <Table caption="Daftar pelanggan" empty="Belum ada data." rows={data.items} onRow={(c) => setOpen(c.id)} cols={[{ key: "name", label: "Nama", render: (c) => <button className="underline" onClick={() => setOpen(c.id)}>{c.name}</button> }, { key: "phone", label: "Telepon" }, { key: "email", label: "Email" }, { key: "group_name", label: "Grup" }, { key: "credit_limit", label: "Batas kredit", num: true, render: (c) => m(c.credit_limit) }, { key: "outstanding", label: "Piutang", num: true, render: (c) => m(c.outstanding) }]} />}
          {data && <Pager offset={offset} limit={25} count={data.items.length} onChange={setOffset} />}
        </div>
      </Card>
      {open && <Detail id={open} onClose={() => setOpen(null)} />}
      {modal && <FormModal title="Pelanggan baru" onClose={() => setModal(false)} fields={[{ key: "name", label: "Nama", required: true }, { key: "phone", label: "Telepon" }, { key: "email", label: "Email", type: "email" }, { key: "address", label: "Alamat" }, { key: "groupName", label: "Grup / segmen", hint: "Dipakai aturan harga/diskon" }, { key: "creditLimit", label: "Batas kredit", type: "number", def: "0" }, { key: "consentMarketing", label: "Setuju menerima info promosi", type: "checkbox" }]}
        onSubmit={async (v) => { await api("customers", { body: { name: v.name, phone: v.phone || null, email: v.email || null, address: v.address || null, groupName: v.groupName || null, creditLimit: v.creditLimit || "0", consentMarketing: !!v.consentMarketing } }); toast("Pelanggan disimpan"); reload(); }} />}
    </>
  );
}
