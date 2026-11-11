/** Declarative definition of the "record" based modules (tasks, HR, operations, marketing, projects, assets,
 *  privacy registers and template workflows). One validated engine, many typed kinds. */
export type FieldType = "text" | "textarea" | "number" | "date" | "select";
export type Field = { key: string; label: string; type: FieldType; options?: string[]; required?: boolean };
export type Kind = {
  id: string;
  module: string; // permission module
  group: string; // navigation group label
  label: string;
  fields: Field[];
  statuses: string[];
  approveStatuses?: string[]; // moving INTO these needs "<module>:approve"
  parentKind?: string;
  selfService?: boolean; // employees may create (hr:self)
  templates?: string[]; // only shown for these templates (others hidden, still valid)
  sensitive?: boolean;
};

const t = (key: string, label: string, required = false): Field => ({ key, label, type: "text", required });
const ta = (key: string, label: string): Field => ({ key, label, type: "textarea" });
const n = (key: string, label: string, required = false): Field => ({ key, label, type: "number", required });
const d = (key: string, label: string, required = false): Field => ({ key, label, type: "date", required });
const s = (key: string, label: string, options: string[], required = false): Field => ({ key, label, type: "select", options, required });
const title = (label = "Judul") => t("title", label, true);

const TASK_ST = ["todo", "doing", "review", "done", "cancelled"];

export const KINDS: Kind[] = [
  // Tugas & tim
  { id: "task", module: "tasks", group: "Tugas & Tim", label: "Tugas", statuses: TASK_ST, approveStatuses: [], fields: [title("Judul tugas"), s("priority", "Prioritas", ["rendah", "sedang", "tinggi", "urgen"]), d("dueDate", "Tenggat"), t("assignee", "Penanggung jawab"), ta("checklist", "Checklist (satu baris per item)"), s("recurrence", "Berulang", ["tidak", "harian", "mingguan", "bulanan"]), ta("notes", "Catatan")] },
  { id: "subtask", module: "tasks", group: "Tugas & Tim", label: "Subtugas", parentKind: "task", statuses: TASK_ST, fields: [title("Judul subtugas"), t("assignee", "Penanggung jawab"), d("dueDate", "Tenggat")] },
  { id: "agenda", module: "tasks", group: "Tugas & Tim", label: "Agenda & Pengingat", statuses: ["scheduled", "done", "cancelled"], fields: [title("Judul"), d("dueDate", "Tanggal", true), t("time", "Jam (HH:MM)"), s("type", "Jenis", ["agenda", "pengingat", "rapat"]), ta("notes", "Catatan")] },
  // Penjualan / CRM
  { id: "lead", module: "crm", group: "Pelanggan & Penjualan", label: "Lead & Peluang", statuses: ["new", "contacted", "qualified", "proposal", "won", "lost"], fields: [title("Nama lead"), t("contact", "Kontak"), n("amount", "Nilai peluang"), d("dueDate", "Perkiraan closing"), t("assignee", "Sales"), s("source", "Sumber", ["walk-in", "referral", "online", "iklan", "lainnya"])] },
  { id: "interaction", module: "crm", group: "Pelanggan & Penjualan", label: "Riwayat Interaksi Pelanggan", statuses: ["logged", "follow_up", "closed"], fields: [title("Ringkasan"), t("customer", "Nama pelanggan", true), s("channel", "Kanal", ["telepon", "WhatsApp", "email", "tatap muka"]), d("dueDate", "Tindak lanjut"), ta("notes", "Catatan")] },
  { id: "sales_team", module: "sales", group: "Pelanggan & Penjualan", label: "Tim & Sales Rep", statuses: ["active", "inactive"], fields: [title("Nama sales / tim"), t("team", "Tim"), n("target", "Target bulanan"), n("amount", "Komisi (%)")] },
  // HR
  { id: "employee", module: "hr", group: "Karyawan & HR", label: "Karyawan", sensitive: true, statuses: ["active", "probation", "on_leave", "resigned"], fields: [t("title", "Nama karyawan", true), t("position", "Jabatan"), t("department", "Departemen"), s("employment", "Status kerja", ["tetap", "kontrak", "magang", "harian"]), d("joinDate", "Tanggal masuk"), n("amount", "Gaji pokok"), t("phone", "Telepon"), t("shift", "Shift / jam kerja")] },
  { id: "department", module: "hr", group: "Karyawan & HR", label: "Departemen & Jabatan", statuses: ["active", "inactive"], fields: [title("Nama departemen"), t("head", "Kepala")] },
  { id: "attendance", module: "hr", group: "Karyawan & HR", label: "Absensi", selfService: true, statuses: ["present", "late", "absent", "leave"], fields: [t("title", "Nama karyawan", true), d("dueDate", "Tanggal", true), t("checkIn", "Jam masuk"), t("checkOut", "Jam pulang"), t("shift", "Shift")] },
  { id: "timesheet", module: "hr", group: "Karyawan & HR", label: "Timesheet & Lembur", selfService: true, statuses: ["submitted", "approved", "rejected"], approveStatuses: ["approved", "rejected"], fields: [t("title", "Nama karyawan", true), d("dueDate", "Tanggal", true), n("hours", "Jam kerja", true), n("overtime", "Jam lembur"), t("project", "Proyek / pekerjaan")] },
  { id: "leave", module: "hr", group: "Karyawan & HR", label: "Cuti", selfService: true, statuses: ["pending", "approved", "rejected"], approveStatuses: ["approved", "rejected"], fields: [t("title", "Nama karyawan", true), s("type", "Jenis", ["tahunan", "sakit", "izin", "lainnya"]), d("dueDate", "Mulai", true), d("endDate", "Selesai", true), ta("reason", "Alasan")] },
  { id: "payroll", module: "hr", group: "Karyawan & HR", label: "Catatan Penggajian", sensitive: true, statuses: ["draft", "approved", "paid_recorded"], approveStatuses: ["approved", "paid_recorded"], fields: [t("title", "Nama karyawan", true), t("period", "Periode (YYYY-MM)", true), n("basic", "Gaji pokok", true), n("allowance", "Tunjangan"), n("deduction", "Potongan")] },
  // Operasional
  { id: "sop", module: "operations", group: "Operasional", label: "SOP", statuses: ["draft", "active", "retired"], fields: [title("Judul SOP"), t("owner", "Penanggung jawab"), ta("steps", "Langkah-langkah")] },
  { id: "checklist", module: "operations", group: "Operasional", label: "Checklist Buka/Tutup", statuses: ["open", "completed"], fields: [title("Nama checklist"), s("type", "Jenis", ["buka toko", "tutup toko", "harian", "kebersihan"]), d("dueDate", "Tanggal", true), t("branch", "Cabang"), ta("items", "Item (satu baris per item)"), ta("done", "Item selesai (baris yang selesai)")] },
  { id: "handover", module: "operations", group: "Operasional", label: "Serah Terima Shift", statuses: ["submitted", "acknowledged"], fields: [title("Judul"), d("dueDate", "Tanggal", true), t("fromShift", "Dari shift"), t("toShift", "Ke shift"), ta("notes", "Catatan serah terima")] },
  { id: "qc", module: "operations", group: "Operasional", label: "Kontrol Kualitas", statuses: ["pass", "fail", "rework"], fields: [title("Objek pemeriksaan"), d("dueDate", "Tanggal", true), ta("notes", "Temuan")] },
  { id: "incident", module: "operations", group: "Operasional", label: "Insiden", statuses: ["reported", "investigating", "resolved", "closed"], approveStatuses: ["closed"], fields: [title("Judul insiden"), s("severity", "Tingkat", ["rendah", "sedang", "tinggi"]), d("dueDate", "Tanggal", true), ta("notes", "Kronologi & tindakan")] },
  // Marketing
  { id: "campaign", module: "marketing", group: "Pemasaran", label: "Kampanye", statuses: ["planned", "running", "completed", "cancelled"], fields: [title("Nama kampanye"), t("channel", "Kanal"), d("dueDate", "Mulai"), d("endDate", "Selesai"), n("amount", "Biaya pemasaran"), n("revenue", "Hasil penjualan terkait"), t("segment", "Segmen sasaran")] },
  { id: "promotion", module: "marketing", group: "Pemasaran", label: "Promosi", statuses: ["draft", "active", "ended"], fields: [title("Nama promo"), t("code", "Kode promo"), n("discountPercent", "Diskon (%)"), d("dueDate", "Mulai"), d("endDate", "Selesai")] },
  { id: "message_template", module: "marketing", group: "Pemasaran", label: "Template Pesan (salin manual)", statuses: ["active", "archived"], fields: [title("Nama template"), s("channel", "Kanal", ["WhatsApp", "SMS", "email"]), ta("body", "Isi pesan")] },
  // Proyek
  { id: "project", module: "projects", group: "Proyek", label: "Proyek", statuses: ["planning", "active", "on_hold", "completed", "cancelled"], approveStatuses: ["completed"], fields: [title("Nama proyek"), t("client", "Klien"), n("amount", "Anggaran"), d("dueDate", "Tenggat"), n("progress", "Progres (%)"), t("assignee", "Manajer proyek")] },
  { id: "milestone", module: "projects", group: "Proyek", label: "Milestone & Fase", parentKind: "project", statuses: ["pending", "in_progress", "done"], fields: [title("Nama milestone"), d("dueDate", "Tenggat"), n("amount", "Nilai")] },
  { id: "project_cost", module: "projects", group: "Proyek", label: "Biaya Proyek", parentKind: "project", statuses: ["recorded", "approved"], approveStatuses: ["approved"], fields: [title("Uraian"), n("amount", "Biaya", true), d("dueDate", "Tanggal", true), t("resource", "Sumber daya")] },
  // Aset & dokumen
  { id: "asset", module: "assets", group: "Aset & Dokumen", label: "Aset", statuses: ["active", "in_maintenance", "disposed"], approveStatuses: ["disposed"], fields: [title("Nama aset"), t("code", "Kode aset"), t("category", "Kategori"), n("amount", "Harga perolehan"), d("dueDate", "Tanggal perolehan"), n("usefulLifeMonths", "Umur manfaat (bulan)"), n("salvage", "Nilai sisa"), t("location", "Lokasi"), t("assignee", "Dipegang oleh"), s("condition", "Kondisi", ["baik", "cukup", "rusak"]), d("warrantyUntil", "Garansi s/d")] },
  { id: "maintenance", module: "assets", group: "Aset & Dokumen", label: "Perawatan Aset", parentKind: "asset", statuses: ["scheduled", "done", "cancelled"], fields: [title("Pekerjaan perawatan"), d("dueDate", "Tanggal", true), n("amount", "Biaya")] },
  { id: "document", module: "assets", group: "Aset & Dokumen", label: "Dokumen", statuses: ["active", "archived"], fields: [title("Judul dokumen"), t("category", "Kategori"), t("version", "Versi"), d("retentionUntil", "Simpan sampai"), t("fileId", "ID berkas (dari unggahan)")] },
  // Finance extras
  { id: "budget", module: "finance", group: "Keuangan", label: "Anggaran", statuses: ["draft", "approved"], approveStatuses: ["approved"], fields: [title("Nama anggaran"), t("accountCode", "Kode akun"), t("period", "Periode (YYYY-MM)", true), n("amount", "Jumlah", true)] },
  // Master data
  { id: "uom", module: "business", group: "Data Master", label: "Satuan (UOM)", statuses: ["active"], fields: [title("Nama satuan"), t("code", "Kode"), n("factor", "Faktor ke satuan dasar")] },
  { id: "exchange_rate", module: "business", group: "Data Master", label: "Kurs Mata Uang", statuses: ["active"], fields: [t("title", "Pasangan mata uang (mis. USD/IDR)", true), n("amount", "Kurs", true), d("dueDate", "Berlaku sejak", true)] },
  // Privasi (UU PDP)
  { id: "data_inventory", module: "privacy", group: "Privasi & Legal", label: "Inventaris Data Pribadi", statuses: ["active", "retired"], fields: [title("Kategori data"), t("purpose", "Tujuan pemrosesan"), s("legalBasis", "Dasar hukum", ["persetujuan", "kontrak", "kewajiban hukum", "kepentingan sah", "kepentingan vital"]), t("retention", "Masa retensi"), t("subprocessor", "Pemroses/subprocessor"), s("crossBorder", "Transfer lintas negara", ["tidak", "ya"])] },
  { id: "retention_rule", module: "privacy", group: "Privasi & Legal", label: "Aturan Retensi", statuses: ["active", "retired"], fields: [title("Jenis data"), n("months", "Retensi (bulan)", true), ta("notes", "Dasar & keterangan")] },
  { id: "privacy_incident", module: "privacy", group: "Privasi & Legal", label: "Insiden Privasi", statuses: ["reported", "assessing", "notified", "closed"], approveStatuses: ["notified", "closed"], fields: [title("Judul"), d("dueDate", "Tanggal terdeteksi", true), ta("notes", "Ringkasan (pemberitahuan wajib ≤ 3x24 jam bila memenuhi syarat)")] },
  { id: "legal_hold", module: "privacy", group: "Privasi & Legal", label: "Legal Hold", statuses: ["active", "released"], approveStatuses: ["released"], fields: [title("Subjek/perkara"), ta("notes", "Alasan")] },

  { id: "resource", module: "bookings", group: "Booking & Reservasi", label: "Sumber Daya (kursi, ruang, lapangan)", statuses: ["available", "unavailable"], fields: [title("Nama sumber daya"), t("type", "Jenis"), n("capacity", "Kapasitas simultan")] },
  // ── Workflow khusus template ──
  { id: "restaurant_table", module: "bookings", group: "Workflow Restoran", label: "Meja", templates: ["restaurant"], statuses: ["available", "occupied", "reserved"], fields: [title("Nama/nomor meja"), n("capacity", "Kapasitas")] },
  { id: "kitchen_ticket", module: "operations", group: "Workflow Restoran", label: "Tiket Dapur", templates: ["restaurant"], statuses: ["new", "preparing", "ready", "served", "cancelled"], fields: [title("Meja / pesanan"), ta("items", "Item & modifier"), ta("notes", "Catatan")] },
  { id: "laundry_order", module: "operations", group: "Workflow Laundry", label: "Order Laundry", templates: ["laundry"], statuses: ["received", "washing", "drying", "ironing", "ready", "picked_up", "claim"], fields: [title("Pelanggan"), s("service", "Layanan", ["kiloan", "satuan", "express", "dry clean"]), n("weightKg", "Berat (kg)"), n("items", "Jumlah item"), n("amount", "Harga"), d("dueDate", "Tenggat selesai"), ta("notes", "Catatan / klaim")] },
  { id: "salon_staff", module: "bookings", group: "Workflow Salon", label: "Staf & Jadwal", templates: ["salon", "clinic", "gym"], statuses: ["active", "off"], fields: [title("Nama staf / praktisi"), t("specialty", "Keahlian / spesialisasi"), t("schedule", "Jadwal kerja")] },
  { id: "vehicle", module: "operations", group: "Workflow Bengkel", label: "Kendaraan Pelanggan", templates: ["workshop"], statuses: ["active"], fields: [title("Plat nomor"), t("brand", "Merek/Model"), t("owner", "Pemilik"), n("odometer", "Odometer (km)")] },
  { id: "job_card", module: "operations", group: "Workflow Bengkel", label: "Job Card", templates: ["workshop"], statuses: ["received", "diagnosed", "approved", "in_progress", "qc", "done", "delivered"], approveStatuses: ["approved"], fields: [title("Plat nomor"), ta("complaint", "Keluhan"), ta("diagnosis", "Diagnosis operasional"), ta("parts", "Suku cadang"), n("amount", "Estimasi/biaya total"), n("laborCost", "Biaya jasa"), ta("inspection", "Inspeksi")] },
  { id: "delivery_schedule", module: "operations", group: "Workflow Pengiriman", label: "Jadwal Pengiriman", templates: ["catering", "distributor"], statuses: ["scheduled", "on_the_way", "delivered", "failed"], fields: [title("Penerima / pesanan"), t("address", "Alamat"), d("dueDate", "Tanggal kirim", true), t("driver", "Kurir/sopir")] },
  { id: "collection", module: "operations", group: "Workflow Fashion", label: "Koleksi & Musim", templates: ["fashion"], statuses: ["planned", "active", "ended"], fields: [title("Nama koleksi"), t("season", "Musim"), d("dueDate", "Rilis")] },
  { id: "room", module: "bookings", group: "Workflow Hotel/Villa", label: "Kamar / Unit", templates: ["hotel"], statuses: ["available", "occupied", "cleaning", "maintenance"], fields: [title("Nomor kamar"), t("roomType", "Tipe kamar"), n("capacity", "Kapasitas tamu"), n("amount", "Tarif per malam")] },
  { id: "housekeeping", module: "operations", group: "Workflow Hotel/Villa", label: "Housekeeping", templates: ["hotel"], statuses: ["pending", "in_progress", "done"], fields: [title("Kamar & tugas"), t("assignee", "Petugas"), d("dueDate", "Tanggal", true)] },
  { id: "delivery_order", module: "sales", group: "Workflow Distributor", label: "Surat Jalan", templates: ["distributor"], statuses: ["draft", "loaded", "on_delivery", "delivered"], fields: [title("Customer / No. faktur"), t("address", "Alamat"), t("driver", "Sopir"), t("vehicle", "Kendaraan"), d("dueDate", "Tanggal kirim")] },
  { id: "boq_item", module: "projects", group: "Workflow Kontraktor", label: "BOQ / RAB", templates: ["contractor"], parentKind: "project", statuses: ["planned", "ordered", "done"], fields: [title("Uraian pekerjaan"), t("unit", "Satuan"), n("qty", "Volume", true), n("unitPrice", "Harga satuan", true), n("amount", "Jumlah (otomatis = volume × harga)")] },
  { id: "subcontractor", module: "projects", group: "Workflow Kontraktor", label: "Subkontraktor", templates: ["contractor"], statuses: ["active", "completed"], fields: [title("Nama subkontraktor"), t("scope", "Lingkup"), n("amount", "Nilai kontrak")] },
  { id: "progress_report", module: "projects", group: "Workflow Kontraktor", label: "Laporan Progres", templates: ["contractor"], parentKind: "project", statuses: ["submitted", "approved"], approveStatuses: ["approved"], fields: [title("Periode / minggu"), n("progress", "Progres (%)", true), ta("notes", "Catatan")] },
  { id: "membership", module: "crm", group: "Workflow Gym", label: "Membership", templates: ["gym"], statuses: ["active", "expired", "frozen", "cancelled"], fields: [title("Nama member"), t("plan", "Paket"), d("dueDate", "Mulai", true), d("endDate", "Berakhir", true), n("amount", "Biaya (pencatatan manual)")] },
  { id: "fitness_class", module: "bookings", group: "Workflow Gym", label: "Kelas", templates: ["gym", "education"], statuses: ["scheduled", "completed", "cancelled"], fields: [title("Nama kelas"), t("trainer", "Pelatih / pengajar"), d("dueDate", "Tanggal", true), t("time", "Jam"), n("capacity", "Kapasitas")] },
  { id: "class_attendance", module: "hr", group: "Workflow Gym", label: "Kehadiran Kelas", templates: ["gym", "education"], statuses: ["present", "absent", "excused"], selfService: false, fields: [title("Nama peserta"), t("className", "Kelas"), d("dueDate", "Tanggal", true)] },
  { id: "engagement", module: "projects", group: "Workflow Jasa Profesional", label: "Engagement Klien", templates: ["professional"], statuses: ["proposal", "active", "completed", "cancelled"], fields: [title("Klien / proyek"), ta("scope", "Lingkup"), n("amount", "Nilai fee"), d("dueDate", "Tenggat")] },
  { id: "deliverable", module: "projects", group: "Workflow Jasa Profesional", label: "Deliverable", templates: ["professional"], parentKind: "engagement", statuses: ["pending", "in_review", "delivered", "accepted"], fields: [title("Deliverable"), d("dueDate", "Tenggat")] },
  { id: "enrollment", module: "crm", group: "Workflow Pendidikan", label: "Pendaftaran Siswa", templates: ["education"], statuses: ["registered", "active", "completed", "dropped"], fields: [title("Nama siswa"), t("className", "Kelas"), t("guardian", "Wali"), d("dueDate", "Tanggal daftar")] },
  { id: "tuition_record", module: "finance", group: "Workflow Pendidikan", label: "Catatan SPP (manual)", templates: ["education"], statuses: ["unpaid", "paid"], fields: [title("Nama siswa"), t("period", "Periode"), n("amount", "Nominal", true), d("dueDate", "Jatuh tempo")] },
  { id: "class_group", module: "bookings", group: "Workflow Pendidikan", label: "Kelas & Jadwal", templates: ["education"], statuses: ["active", "ended"], fields: [title("Nama kelas"), t("instructor", "Pengajar"), t("schedule", "Jadwal")] },
  { id: "queue_ticket", module: "bookings", group: "Workflow Klinik", label: "Antrian Pasien (tanpa data medis)", templates: ["clinic"], statuses: ["waiting", "called", "in_service", "done", "cancelled"], fields: [title("Nama / kode antrian"), t("practitioner", "Praktisi"), t("service", "Layanan"), d("dueDate", "Tanggal", true)] },
  { id: "fleet", module: "bookings", group: "Workflow Rental", label: "Armada", templates: ["rental"], statuses: ["available", "rented", "maintenance"], fields: [title("Plat nomor"), t("type", "Jenis/Model"), n("odometer", "Odometer (km)"), n("amount", "Tarif per hari")] },
  { id: "rental_handover", module: "operations", group: "Workflow Rental", label: "Serah Terima & Inspeksi", templates: ["rental"], statuses: ["pickup", "returned", "damage_reported"], fields: [title("Plat nomor / penyewa"), n("odometer", "Odometer (km)"), s("fuel", "BBM", ["penuh", "3/4", "1/2", "1/4", "kosong"]), ta("damage", "Catatan kerusakan"), d("dueDate", "Tanggal", true)] },
  { id: "custom_item", module: "operations", group: "Workflow Kustom", label: "Item Kustom", templates: ["other"], statuses: ["new", "in_progress", "done"], fields: [title("Judul"), t("category", "Kategori"), n("amount", "Nilai"), ta("attributes", "Atribut kustom (kunci: nilai per baris)")] },
];

export const KIND_MAP = new Map(KINDS.map((k) => [k.id, k]));
