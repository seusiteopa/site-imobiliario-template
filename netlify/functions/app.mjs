import { getStore } from "@netlify/blobs";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export const config = { path: "/*" };

const S = (n) => getStore({ name: n, consistency: "strong" });
const CATS = ["casas", "apartamentos", "terrenos", "chacaras", "fazendas", "salas", "galpoes", "lancamentos"];
const SIT = ["disponivel", "reservado", "fechado"];
const DEF = {
  nome: "Aurora Imóveis", cidade: "", creci: "", whatsapp: "", telefone: "", email: "", endereco: "", horario: "",
  instagram: "", facebook: "", corPrimaria: "#14403A", corDestaque: "#B4441F", fonte: "classica",
  heroTitulo: "O imóvel certo, a uma conversa de distância.",
  heroSub: "Veja fotos, preço e detalhes de cada imóvel e chame a {imobiliaria} no WhatsApp para tirar dúvidas e combinar a visita.",
  sobre: "A {imobiliaria} ajuda pessoas a comprar, vender e alugar imóveis em {cidade}. Aqui você encontra informações claras sobre cada imóvel e fala direto com a nossa equipe.",
  contatoTxt: "Fale com a nossa equipe e conte o que você busca.",
  msg: "Olá! Tenho interesse em {acao} este imóvel:\n\n*{titulo}* (REF {codigo})\n{fatos}\n{preco}\n{local}\n\n{descricao}\n\n{link}",
  banner: 0, logo: 0,
};
const CK = { nome: 80, cidade: 60, creci: 30, telefone: 30, email: 80, endereco: 150, horario: 100, heroTitulo: 120, heroSub: 300, sobre: 1500, contatoTxt: 200, msg: 1200 };

const T = (v, n) => String(v ?? "").trim().slice(0, n);
const N = (v, mx) => { v = Number(v); return v === v && v >= 0 ? Math.min(v, mx) : null; };
const eA = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slug = (s) => T(s, 60).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "imovel";
const J = (d, s = 200, h = {}) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...h } });
const PUB = { "cache-control": "public, max-age=0, must-revalidate", "netlify-cdn-cache-control": "public, max-age=20, stale-while-revalidate=40" };
const sha = (s) => createHash("sha256").update(s).digest();

async function getCfg() { return { ...DEF, ...((await S("config").get("site", { type: "json" })) || {}) }; }

function cleanCfg(b, o) {
  const r = { ...o };
  for (const k in CK) if (k in b) r[k] = T(b[k], CK[k]);
  if (!r.nome) r.nome = o.nome || DEF.nome;
  if ("whatsapp" in b) { let w = String(b.whatsapp || "").replace(/\D/g, "").slice(0, 15); if (w.length >= 10 && w.length <= 11) w = "55" + w; r.whatsapp = w; }
  for (const k of ["instagram", "facebook"]) if (k in b) r[k] = /^https:\/\//.test(T(b[k], 200)) ? T(b[k], 200) : "";
  for (const k of ["corPrimaria", "corDestaque"]) if (/^#[0-9a-fA-F]{6}$/.test(b[k] || "")) r[k] = b[k];
  if (["classica", "moderna", "editorial"].includes(b.fonte)) r.fonte = b.fonte;
  return r;
}

function limpa(b) {
  return {
    titulo: T(b.titulo, 120), finalidade: b.finalidade === "aluguel" ? "aluguel" : "venda",
    categoria: CATS.includes(b.categoria) ? b.categoria : "casas", situacao: SIT.includes(b.situacao) ? b.situacao : "disponivel",
    status: b.status === "publicado" ? "publicado" : "rascunho", destaque: !!b.destaque,
    preco: N(b.preco, 1e10), psc: !!b.psc, quartos: N(b.quartos, 99), banheiros: N(b.banheiros, 99), vagas: N(b.vagas, 99), area: N(b.area, 1e7),
    cidade: T(b.cidade, 60), bairro: T(b.bairro, 60), endereco: T(b.endereco, 150), mostrarEnd: !!b.mostrarEnd,
    descricao: T(b.descricao, 4000), corretor: T(b.corretor, 80),
    comodidades: (Array.isArray(b.comodidades) ? b.comodidades : []).slice(0, 40).map((x) => T(x, 40)).filter(Boolean),
    fotos: (Array.isArray(b.fotos) ? b.fotos : []).slice(0, 40).map((f) => ({ id: String(f?.id || "").replace(/[^a-z0-9]/g, "").slice(0, 12), alt: T(f?.alt, 120) })).filter((f) => f.id),
  };
}

const resumo = (d) => ({
  id: d.id, slug: d.slug, codigo: d.codigo, titulo: d.titulo, finalidade: d.finalidade, categoria: d.categoria, situacao: d.situacao,
  status: d.status, destaque: d.destaque, preco: d.preco, psc: d.psc, quartos: d.quartos, banheiros: d.banheiros, vagas: d.vagas, area: d.area,
  cidade: d.cidade, bairro: d.bairro, capa: d.fotos[0]?.id || "", criado: d.criado, atual: d.atual,
});

async function reindex() {
  const st = S("imoveis");
  const { blobs } = await st.list();
  const all = (await Promise.all(blobs.map((b) => st.get(b.key, { type: "json" })))).filter(Boolean).sort((a, b) => b.criado - a.criado);
  const ix = S("indices");
  await ix.setJSON("admin", all.map(resumo));
  await ix.setJSON("publico", all.filter((d) => d.status === "publicado").map(resumo));
}

const pubIdx = async () => (await S("indices").get("publico", { type: "json" })) || [];
async function imovelPub(sl) {
  const id = sl.split("-").pop();
  if (!/^[a-z0-9]{6,12}$/.test(id)) return null;
  const d = await S("imoveis").get(id, { type: "json" });
  if (!d || d.status !== "publicado" || d.slug !== sl) return null;
  if (!d.mostrarEnd) d.endereco = "";
  return d;
}

// ---------- sessão ----------
const SEC = () => process.env.AUTH_SECRET || "";
const sign = (p) => createHmac("sha256", SEC()).update(p).digest("base64url");
const mk = () => { const p = Buffer.from(JSON.stringify({ e: Date.now() + 6048e5 })).toString("base64url"); return p + "." + sign(p); };
function logado(req) {
  const c = (req.headers.get("cookie") || "").match(/(?:^|; )sessao=([^;]+)/);
  if (!c || !SEC()) return false;
  const [p, s] = c[1].split(".");
  if (!p || !s) return false;
  const a = Buffer.from(sign(p)), b = Buffer.from(s);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try { return JSON.parse(Buffer.from(p, "base64url")).e > Date.now(); } catch { return false; }
}
const mesmaOrigem = (req) => { const o = req.headers.get("origin"); return !o || new URL(o).host === new URL(req.url).host; };
const mime = (b) => { const u = new Uint8Array(b); if (u[0] === 255 && u[1] === 216) return "image/jpeg"; if (u[0] === 137 && u[1] === 80 && u[2] === 78 && u[3] === 71) return "image/png"; if (u[0] === 82 && u[1] === 73 && u[8] === 87 && u[9] === 69) return "image/webp"; return ""; };
const img = (data, type) => new Response(data, { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" } });

// ---------- API ----------
async function api(req, u, p, m) {
  let r;
  if (p === "/api/publico" && m === "GET") return J({ c: await getCfg(), i: await pubIdx() }, 200, PUB);
  if ((r = p.match(/^\/api\/imovel\/([a-z0-9-]+)$/)) && m === "GET") { const d = await imovelPub(r[1]); return d ? J(d, 200, PUB) : J({ erro: "Imóvel não encontrado" }, 404); }
  if ((r = p.match(/^\/api\/foto\/([a-z0-9]+)\/([a-z0-9]+)\/(g|m|p|og)$/)) && m === "GET") {
    const x = await getStore("fotos").getWithMetadata(`${r[1]}/${r[2]}-${r[3]}`, { type: "arrayBuffer" });
    return x ? img(x.data, x.metadata.t) : new Response("", { status: 404 });
  }
  if ((r = p.match(/^\/api\/marca\/(logo|banner)$/)) && m === "GET") {
    const x = await S("marca").getWithMetadata(r[1], { type: "arrayBuffer" });
    return x ? img(x.data, x.metadata.t) : new Response("", { status: 404 });
  }
  if (p === "/api/clique" && m === "POST") {
    const b = await req.json().catch(() => ({}));
    if (/^[a-z0-9]{6,12}$/.test(b.id || "")) { const d = new Date(); await getStore("cliques").set(`${d.toISOString().slice(0, 7)}/${b.id}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, "1"); }
    return J({ ok: 1 });
  }
  if (p === "/api/login" && m === "POST") {
    if (!process.env.ADMIN_PASSWORD || !SEC()) return J({ erro: "Admin não configurado. Defina ADMIN_PASSWORD e AUTH_SECRET no Netlify." }, 503);
    if (!mesmaOrigem(req)) return J({ erro: "Origem inválida" }, 403);
    const ip = req.headers.get("x-nf-client-connection-ip") || "x", k = "t-" + sha(ip).toString("hex").slice(0, 24), st = S("seguranca");
    const t = (await st.get(k, { type: "json" })) || { n: 0, t: 0 };
    if (Date.now() - t.t > 9e5) t.n = 0;
    if (t.n >= 5) return J({ erro: "Muitas tentativas. Aguarde alguns minutos e tente de novo." }, 429);
    const b = await req.json().catch(() => ({}));
    if (!timingSafeEqual(sha(String(b.senha || "")), sha(process.env.ADMIN_PASSWORD))) { await st.setJSON(k, { n: t.n + 1, t: Date.now() }); return J({ erro: "Senha incorreta. Tente novamente." }, 401); }
    await st.delete(k);
    return J({ ok: 1 }, 200, { "set-cookie": `sessao=${mk()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800` });
  }
  if (p === "/api/logout" && m === "POST") return J({ ok: 1 }, 200, { "set-cookie": "sessao=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0" });

  if (!p.startsWith("/api/admin/")) return J({ erro: "Não encontrado" }, 404);
  if (!logado(req)) return J({ erro: "Sua sessão expirou. Entre novamente para continuar." }, 401);
  if (m !== "GET" && !mesmaOrigem(req)) return J({ erro: "Origem inválida" }, 403);

  if (p === "/api/admin/imoveis" && m === "GET") return J((await S("indices").get("admin", { type: "json" })) || []);
  if (p === "/api/admin/config" && m === "GET") return J(await getCfg());
  if (p === "/api/admin/config" && m === "PUT") { const b = await req.json().catch(() => ({})); const c = cleanCfg(b, await getCfg()); await S("config").setJSON("site", c); return J(c); }
  if (p === "/api/admin/reindexar" && m === "POST") { await reindex(); return J({ ok: 1 }); }
  if (p === "/api/admin/estatisticas" && m === "GET") {
    const { blobs } = await getStore("cliques").list({ prefix: new Date().toISOString().slice(0, 7) + "/" });
    return J({ cliquesMes: blobs.length });
  }
  if ((r = p.match(/^\/api\/admin\/imoveis\/([a-z0-9]{6,12})$/))) {
    const id = r[1], st = S("imoveis"), old = await st.get(id, { type: "json" });
    if (m === "GET") return old ? J(old) : J({ erro: "Não encontrado" }, 404);
    if (m === "PUT") {
      const b = await req.json().catch(() => ({})), x = limpa(b);
      if (x.status === "publicado") {
        if (!x.titulo) return J({ erro: "Informe o título." }, 400);
        if (x.preco == null && !x.psc) return J({ erro: "Informe o preço ou marque 'Preço sob consulta'." }, 400);
        if (!x.fotos.length) return J({ erro: "Envie pelo menos uma foto." }, 400);
      }
      const now = Date.now();
      const d = { ...x, id, slug: old?.slug || slug(x.titulo) + "-" + id, codigo: T(b.codigo, 20) || old?.codigo || id.slice(-4).toUpperCase(), criado: old?.criado || now, atual: now };
      const fs = getStore("fotos");
      for (const f of old?.fotos || []) if (!d.fotos.some((n) => n.id === f.id)) for (const t of ["g", "m", "p", "og"]) await fs.delete(`${id}/${f.id}-${t}`);
      await st.setJSON(id, d); await reindex();
      return J(d);
    }
    if (m === "DELETE") {
      const fs = getStore("fotos"), { blobs } = await fs.list({ prefix: id + "/" });
      for (const b of blobs) await fs.delete(b.key);
      await st.delete(id); await reindex();
      return J({ ok: 1 });
    }
  }
  if ((r = p.match(/^\/api\/admin\/foto\/([a-z0-9]{6,12})\/([a-z0-9]{1,12})\/(g|m|p|og)$/)) && m === "PUT") {
    const b = await req.arrayBuffer(), t = mime(b);
    if (!t || b.byteLength > 1.2e6) return J({ erro: "Imagem inválida ou grande demais." }, 400);
    await getStore("fotos").set(`${r[1]}/${r[2]}-${r[3]}`, b, { metadata: { t } });
    return J({ ok: 1 });
  }
  if ((r = p.match(/^\/api\/admin\/marca\/(logo|banner)$/)) && m === "PUT") {
    const b = await req.arrayBuffer(), t = mime(b);
    if (!t || b.byteLength > 1.2e6) return J({ erro: "Imagem inválida ou grande demais." }, 400);
    await S("marca").set(r[1], b, { metadata: { t } });
    const c = await getCfg(); c[r[1]] = Date.now(); await S("config").setJSON("site", c);
    return J(c);
  }
  return J({ erro: "Não encontrado" }, 404);
}

// ---------- páginas ----------
let HTML = "", HASH = "";
function tpl() {
  if (HTML) return;
  for (const f of [new URL("../../landing-page.html", import.meta.url), process.cwd() + "/landing-page.html", (process.env.LAMBDA_TASK_ROOT || ".") + "/landing-page.html"]) { try { HTML = readFileSync(f, "utf8"); break; } catch {} }
  if (!HTML) throw new Error("landing-page.html não encontrado");
  const hs = (re) => [...HTML.matchAll(re)].map((x) => `'sha256-${createHash("sha256").update(x[1]).digest("base64")}'`).join(" ");
  HASH = `default-src 'none'; script-src ${hs(/<script>([\s\S]*?)<\/script>/g)}; style-src ${hs(/<style>([\s\S]*?)<\/style>/g)}; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`;
}
const moeda = (n) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(n);

async function pagina(req, u, p) {
  tpl();
  const c = await getCfg(), o = u.origin, sub = (s) => s.replace(/\{imobiliaria\}/g, c.nome).replace(/\{cidade\}/g, c.cidade || "sua região");
  let M = null, status = 200, t, d;
  const em = c.cidade ? " em " + c.cidade : "";
  t = `${c.nome} | Imóveis para comprar e alugar${em}`;
  d = `Veja casas, apartamentos, terrenos e outros imóveis à venda e para alugar${em}. Fale direto com a ${c.nome} pelo WhatsApp.`;
  let im = "";
  if (p.startsWith("/imovel/")) {
    M = await imovelPub(p.slice(8));
    if (M) {
      const loc = [M.bairro, M.cidade].filter(Boolean).join(", ");
      t = `${M.titulo}${loc ? " em " + loc : ""} | ${c.nome}`;
      d = [M.finalidade === "aluguel" ? "Aluguel" : "Venda", M.quartos ? M.quartos + " quartos" : "", M.area ? M.area + " m²" : "", M.preco != null && !M.psc ? moeda(M.preco) : "", loc].filter(Boolean).join(" · ") + ". Veja as fotos e fale no WhatsApp.";
      if (M.fotos[0]) im = `/api/foto/${M.id}/${M.fotos[0].id}/og`;
    } else status = 404;
  } else if (!["/", "/imoveis", "/favoritos", "/sobre", "/contato", "/admin"].includes(p)) status = 404;
  else if (p === "/imoveis") { t = `Imóveis para comprar e alugar${em} | ${c.nome}`; d = "Filtre por tipo, bairro, preço e número de quartos e encontre o imóvel ideal."; }
  else if (p === "/sobre") t = `Sobre a ${c.nome}`;
  else if (p === "/contato") t = `Fale com a ${c.nome}`;
  const adm = p === "/admin";
  const ld = M ? `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "RealEstateListing", name: M.titulo, url: o + p, description: d, datePosted: new Date(M.criado).toISOString(), ...(im ? { image: o + im } : {}), ...(M.preco != null && !M.psc ? { offers: { "@type": "Offer", price: M.preco, priceCurrency: "BRL" } } : {}) }).replace(/</g, "\\u003c")}</script>` : "";
  const meta = `<title>${eA(t)}</title><meta name="description" content="${eA(d)}"><link rel="canonical" href="${o}${p}"><meta property="og:type" content="website"><meta property="og:site_name" content="${eA(c.nome)}"><meta property="og:title" content="${eA(t)}"><meta property="og:description" content="${eA(d)}"><meta property="og:url" content="${o}${p}">${im ? `<meta property="og:image" content="${o}${im}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">` : ""}${c.logo ? `<link rel="icon" href="/api/marca/logo?v=${c.logo}">` : `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="${c.corPrimaria}"/><text x="16" y="23" font-size="20" text-anchor="middle" fill="#fff" font-family="Georgia,serif">${eA((c.nome || "A")[0].toUpperCase())}</text></svg>`)}">`}${ld}${adm ? '<meta name="robots" content="noindex">' : ""}`;
  const dados = JSON.stringify({ c, i: await pubIdx(), m: M }).replace(/</g, "\\u003c");
  const html = HTML.replace("@@META@@", () => meta).replace("@@DADOS@@", () => dados).replace("@@TEMA@@", () => `data-f="${c.fonte}" style="--c1:${c.corPrimaria};--c2:${c.corDestaque}"`);
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": HASH, ...(adm ? { "cache-control": "no-store" } : PUB) } });
}

export default async (req) => {
  const u = new URL(req.url), p = u.pathname.replace(/(.)\/$/, "$1"), m = req.method;
  try {
    if (p.startsWith("/api/")) return await api(req, u, p, m);
    if (m !== "GET" && m !== "HEAD") return new Response("", { status: 405 });
    if (p === "/robots.txt") return new Response(`User-agent: *\nDisallow: /admin\nDisallow: /api/admin\nSitemap: ${u.origin}/sitemap.xml\n`, { headers: { "content-type": "text/plain" } });
    if (p === "/sitemap.xml") {
      const ix = await pubIdx(), urls = ["", "/imoveis", "/sobre", "/contato"].map((x) => `<url><loc>${u.origin}${x}</loc></url>`).concat(ix.map((d) => `<url><loc>${u.origin}/imovel/${d.slug}</loc><lastmod>${new Date(d.atual).toISOString().slice(0, 10)}</lastmod></url>`));
      return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`, { headers: { "content-type": "application/xml", ...PUB } });
    }
    if (/\.[a-z0-9]{2,5}$/i.test(p)) return new Response("Not found", { status: 404 });
    return await pagina(req, u, p);
  } catch (e) { console.error(e.message); return J({ erro: "Erro interno. Tente novamente." }, 500); }
};
