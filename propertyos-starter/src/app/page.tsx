const sampleProperties = [
  {id:'P-101',name:'Riverside House',location:'Oxford',units:18,occupied:16,status:'Operational'},
  {id:'P-102',name:'Westgate Offices',location:'Reading',units:12,occupied:10,status:'Operational'},
  {id:'P-103',name:'Market Square',location:'Abingdon',units:8,occupied:5,status:'Review'},
];
export default function Home() {
 const total=sampleProperties.reduce((n,p)=>n+p.units,0);
 const occupied=sampleProperties.reduce((n,p)=>n+p.occupied,0);
 return <main className="shell"><aside className="sidebar"><div className="brand">MICROCOREM <span>PropertyOS</span></div><nav aria-label="Main navigation"><a className="active" href="/">Overview</a><a href="#properties">Properties</a></nav><p className="sidebarNote">Portfolio demo · Fictional records</p></aside><section className="content"><header><div><p className="eyebrow">ASSET MANAGEMENT</p><h1>Property overview</h1><p className="muted">A clear view of your property portfolio.</p></div><span className="tag">Demonstration</span></header><div className="metrics"><article><span>Properties</span><strong>{sampleProperties.length}</strong></article><article><span>Total units</span><strong>{total}</strong></article><article><span>Occupancy</span><strong>{Math.round(occupied/total*100)}%</strong></article></div><section className="panel" id="properties"><div className="panelHeading"><h2>Properties</h2><span className="muted">Sample data only</span></div><div className="tableWrap"><table><thead><tr><th>Property</th><th>Location</th><th>Units</th><th>Occupied</th><th>Status</th></tr></thead><tbody>{sampleProperties.map(p=><tr key={p.id}><td><b>{p.name}</b><small>{p.id}</small></td><td>{p.location}</td><td>{p.units}</td><td>{p.occupied}</td><td><span className={p.status==='Review'?'status review':'status'}>{p.status}</span></td></tr>)}</tbody></table></div></section><p className="footnote">Phase 1 is a static UI. Live data, authentication and editing are not implemented yet.</p></section></main>
}
