"""Train separate operational predictors. No calls to the running simulator.
All labels are sampled synthetic outcomes; the operational evidence is a surrogate benchmark.
"""
from pathlib import Path
import csv, gzip, json, hashlib
import numpy as np
import sklearn
from sklearn.ensemble import RandomForestClassifier, ExtraTreesClassifier, GradientBoostingClassifier, RandomForestRegressor, ExtraTreesRegressor, GradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score, accuracy_score, precision_score, recall_score, f1_score, confusion_matrix, roc_auc_score, brier_score_loss, roc_curve, precision_recall_curve
from sklearn.calibration import calibration_curve
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
ROOT=Path(__file__).resolve().parents[2]; OUT=ROOT/'docs/evidence/ml/operational'; PUBLIC=ROOT/'apps/web/public/ml'; OUT.mkdir(parents=True,exist_ok=True)
VERSION='operational-ml-1.0.0'
INV_FEATURES=['inventory_cover_ticks','uncertainty_cv','demand_first_hour_share','demand_first_3h_share','projected_min_cover_1h','projected_min_cover_3h','projected_min_cover_6h','first_arrival_tick','arrival_cover_1h','arrival_cover_3h','arrival_cover_6h','peak_demand_ratio']
NETWORK_FEATURES=['inventory_cover_ticks','uncertainty_cv','first_arrival_tick','supply_cover_1h','supply_cover_6h','supply_cover_12h','supply_cover_24h','supply_cover_48h','supply_cover_96h','demand_first_hour_share','demand_first_3h_share','peak_demand_ratio']
TRANS_FEATURES=['nominal_transit_ticks','hour_sin','hour_cos','depot_constrained','dispatch_load_ratio','observed_mean_delay_ticks','observed_delay_samples']

def inv_features(inv,forecast,arrivals,cv):
 mean=max(1e-6,float(np.mean(forecast))); total=float(np.sum(forecast)); path=inv+np.cumsum(arrivals-forecast); due=np.flatnonzero(arrivals>0)
 return [inv/mean,cv,float(np.sum(forecast[:4]))/total,float(np.sum(forecast[:12]))/total,*[float(min(inv,np.min(path[:k])))/mean for k in [4,12,24]],int(due[0]+1) if len(due) else 25,*[float(np.sum(arrivals[:k]))/mean for k in [4,12,24]],float(np.max(forecast))/mean]
def net_features(inv,forecast,arrivals,cv):
 mean=max(1e-6,float(np.mean(forecast)));total=float(np.sum(forecast));due=np.flatnonzero(arrivals>0)
 return [inv/mean,cv,int(due[0]+1) if len(due) else 385,*[float(np.sum(arrivals[:k]))/mean for k in [4,24,48,96,192,384]],float(np.sum(forecast[:4]))/total,float(np.sum(forecast[:12]))/total,float(np.max(forecast))/mean]
def seasonal(profile,h):
 if profile==0:return 1.45 if 7<=h<10 or 16<=h<21 else .7
 if profile==1:return 1.55 if 6<=h<18 else .45
 if profile==2:return 1.35 if 6<=h<10 or 16<=h<21 else .75
 return 1.25 if 7<=h<21 else .65

def inventory_dataset(depot=False):
 X=[];event=[];eta=[];capped=[];groups=[];ledger=[]
 # Independent complete demand episodes; multiple inventory cases stay in the same partition.
 for ep in range(300):
  rng=np.random.default_rng((53000 if depot else 41000)+ep); profile=ep%4;start=int(rng.integers(0,96));cv=float(rng.uniform(.08,.45));scale=float(rng.uniform(20,450))
  forecast=np.array([scale*seasonal(profile,((start+k)//4)%24) for k in range(1,25)])
  forecast*=rng.uniform(.85,1.3);mean=float(np.mean(forecast))
  for case in range(44):
   inv=mean*(rng.uniform(0,35) if not depot or case%4 else rng.uniform(35,600));arrivals=np.zeros(24)
   for _ in range(int(rng.integers(0,4))):arrivals[int(rng.integers(0,24))]+=mean*rng.uniform(1,32 if not depot else 180)
   # Unknown future demand shocks and errors: labels never supplied as features.
   bias=rng.normal(0,cv*.65);actual=forecast*np.maximum(.05,1+bias+rng.normal(0,cv*.65,24))
   if rng.random()<.13:actual[int(rng.integers(2,20)):]*=rng.uniform(1.3,1.9)
   # Known arrivals are honored. Delays must enter through the supplied arrival schedule.
   path=inv+np.cumsum(arrivals-actual);hit=np.flatnonzero(path<=0);observed=bool(len(hit));time=float(hit[0]+1)/4 if observed else 6.25
   X.append(inv_features(inv,forecast,arrivals,cv));event.append(int(observed));eta.append(time);capped.append(time);groups.append(ep)
   mean_hit=np.flatnonzero(inv+np.cumsum(arrivals-forecast)<=0);ledger.append(float(mean_hit[0]+1)/4 if len(mean_hit) else 6.25)
 return np.asarray(X,dtype=np.float32),np.asarray(event),np.asarray(eta),np.asarray(groups),np.asarray(ledger)

def network_dataset():
 X=[];y=[];groups=[];baseline=[]
 for ep in range(300):
  rng=np.random.default_rng(67000+ep);cv=float(rng.uniform(.04,.35));profile=ep%4;start=int(rng.integers(0,96));scale=float(rng.uniform(100,1500))
  forecast=np.array([scale*seasonal(profile,((start+k)//4)%24) for k in range(1,25)]);mean=float(np.mean(forecast))
  for _ in range(38):
   inv=mean*rng.uniform(.2,500);arrivals=np.zeros(384)
   for _ in range(int(rng.integers(0,5))):arrivals[int(rng.integers(0,384))]+=mean*rng.uniform(5,240)
   actual=mean*np.maximum(.1,1+rng.normal(0,cv*.65)+rng.normal(0,cv*.6,384))
   path=inv+np.cumsum(arrivals-actual);hit=np.flatnonzero(path<=0);hours=float(hit[0]+1)/4 if len(hit) else 96.25
   X.append(net_features(inv,forecast,arrivals,cv));y.append(hours);groups.append(ep);baseline.append(min(96.25,(inv+arrivals.sum())/mean/4))
 return np.asarray(X,dtype=np.float32),np.asarray(y),np.asarray(groups),np.asarray(baseline)

def transport_dataset():
 X=[];y=[];groups=[];baseline=[]
 for ep in range(300):
  rng=np.random.default_rng(79000+ep);nominal=int(rng.choice([2,3,4]));latent=float(rng.choice([0,0,0,.2,.7,1.5,2.5]));histn=int(rng.integers(0,50));histmean=float(np.mean(rng.poisson(latent,histn))) if histn else 0.
  for _ in range(44):
   h=int(rng.integers(0,24));load=float(rng.uniform(0,1.2));constrained=int(rng.random()<.15)
   peak=7<=h<10 or 16<=h<21
   lam=latent+.35*constrained+.3*max(0,load-.65)+(.12 if peak else .02)
   delay=float(min(8,rng.poisson(lam)))
   X.append([nominal,np.sin(h*np.pi/12),np.cos(h*np.pi/12),constrained,load,histmean,histn]);y.append(delay);groups.append(ep);baseline.append(histmean)
 return np.asarray(X,dtype=np.float32),np.asarray(y),np.asarray(groups),np.asarray(baseline)

def export_tree(tree,classifier=False):
 t=tree.tree_;values=t.value[:,0,:]
 value=values[:,1]/np.maximum(values.sum(axis=1),1e-12) if classifier else values[:,0]
 return {'left':t.children_left.tolist(),'right':t.children_right.tolist(),'feature':t.feature.tolist(),'threshold':t.threshold.tolist(),'value':value.tolist()}
def export_model(name,m,classification):
 if isinstance(m,(GradientBoostingRegressor,GradientBoostingClassifier)):
  base=float(np.log(m.init_.class_prior_[1]/m.init_.class_prior_[0])) if classification else float(m.init_.constant_[0,0])
  return {'name':name,'base':base,'rate':m.learning_rate,'transform':'sigmoid' if classification else 'identity','trees':[export_tree(t[0]) for t in m.estimators_]}
 return {'name':name,'base':0.,'rate':1/len(m.estimators_),'transform':'identity','trees':[export_tree(t,classification) for t in m.estimators_]}
def reg_metrics(y,p):return {'mae':float(mean_absolute_error(y,p)),'rmse':float(np.sqrt(mean_squared_error(y,p))),'r2':float(r2_score(y,p))}
def cls_metrics(y,p):
 b=p>=.5
 return {'accuracy':float(accuracy_score(y,b)),'precision':float(precision_score(y,b,zero_division=0)),'recall':float(recall_score(y,b,zero_division=0)),'f1':float(f1_score(y,b,zero_division=0)),'rocAuc':float(roc_auc_score(y,p)),'brier':float(brier_score_loss(y,p)),'matrix':confusion_matrix(y,b,labels=[0,1]).tolist(),'positiveRate':float(np.mean(y))}

artifacts={};reports={};fixtures=[]
def train_task(key,label,X,y,groups,names,unit,classification=False,baseline=None,extra=None):
 train=groups<200;validation=(groups>=200)&(groups<250);test=groups>=250
 if classification:
  models={'Random Forest':RandomForestClassifier(n_estimators=40,max_depth=10,min_samples_leaf=12,n_jobs=2,random_state=41),'Extra Trees':ExtraTreesClassifier(n_estimators=40,max_depth=11,min_samples_leaf=10,n_jobs=2,random_state=42),'Gradient Boosting':GradientBoostingClassifier(n_estimators=80,max_depth=3,min_samples_leaf=15,learning_rate=.07,random_state=43)}
 else:
  models={'Random Forest':RandomForestRegressor(n_estimators=40,max_depth=11,min_samples_leaf=10,n_jobs=2,random_state=41),'Extra Trees':ExtraTreesRegressor(n_estimators=40,max_depth=12,min_samples_leaf=8,n_jobs=2,random_state=42),'Gradient Boosting':GradientBoostingRegressor(n_estimators=90,max_depth=3,min_samples_leaf=15,learning_rate=.07,random_state=43)}
 metrics=[];loss=[];vp=[];tp=[];exports=[]
 for name,m in models.items():
  m.fit(X[train],y[train]);predict=lambda x:m.predict_proba(x)[:,1] if classification else m.predict(x)
  v=predict(X[validation]);t=predict(X[test]);l=brier_score_loss(y[validation],v) if classification else mean_absolute_error(y[validation],v)
  loss.append(max(l,1e-6));vp.append(v);tp.append(t);exports.append(export_model(name,m,classification));metrics.append({'model':name,**(cls_metrics(y[test],t) if classification else reg_metrics(y[test],t))})
  print(key,name,'validation loss',round(l,4),flush=True)
 weights=1/np.array(loss);weights/=weights.sum();v=sum(w*p for w,p in zip(weights,vp));t=sum(w*p for w,p in zip(weights,tp))
 score=cls_metrics(y[test],t) if classification else reg_metrics(y[test],t);metrics.append({'model':'Weighted ensemble',**score})
 if baseline is not None:metrics.append({'model':'Previous planning baseline',**(cls_metrics(y[test],baseline[test]) if classification else reg_metrics(y[test],baseline[test]))})
 residual=float(np.quantile(np.abs(y[validation]-v),.9)) if not classification else None
 report={'key':key,'label':label,'kind':'classification' if classification else 'regression','unit':unit,'features':names,'target':label,'rows':{'train':int(train.sum()),'validation':int(validation.sum()),'test':int(test.sum())},'episodes':{'train':200,'validation':50,'test':50},'weights':dict(zip(models,map(float,weights))),'metrics':metrics,'ensemble':score,'residual90':residual,'testIntervalCoverage':None if classification else float(np.mean(np.abs(y[test]-t)<=residual)),'sample':[{'actual':float(a),'predicted':float(b)} for a,b in zip(y[test][:100],t[:100])],**(extra or {})}
 if classification:
  fpr,tpr,_=roc_curve(y[test],t);fraction,prob=calibration_curve(y[test],t,n_bins=10,strategy='quantile');report['roc']=[{'falsePositiveRate':float(a),'truePositiveRate':float(b)} for a,b in zip(fpr[::max(1,len(fpr)//70)],tpr[::max(1,len(tpr)//70)])];report['calibration']=[{'predicted':float(a),'observed':float(b)} for a,b in zip(prob,fraction)]
 if key=='depot_runway':report['shortageClassification']=cls_metrics((y[test]<=6).astype(int),np.clip((6.25-t)/.5,0,1))
 artifacts[key]={'features':names,'models':exports,'weights':weights.tolist(),'residual90':residual,'report':report};reports[key]=report
 for idx in np.linspace(0,int(test.sum())-1,12,dtype=int):fixtures.append({'task':key,'features':X[test][idx].tolist(),'expected':float(t[idx])})
 with gzip.open(OUT/f'{key}-dataset.csv.gz','wt') as f:
  writer=csv.writer(f);writer.writerow(['episode','split',*names,'target'])
  for i,x in enumerate(X):writer.writerow([int(groups[i]),'train' if train[i] else 'validation' if validation[i] else 'test',*map(float,x),float(y[i])])
 print(key,'ensemble',score,flush=True)

X,event,eta,g,ledger=inventory_dataset()
train_task('stockout_probability','Stockout within six hours',X,event,g,INV_FEATURES,'probability',True,(ledger<=6).astype(float),{'scope':'Sampled demand outcomes with known incoming deliveries; distinct demand episodes across train/validation/test.','threshold':.5})
mask=event==1
train_task('stockout_time','Time to stockout, conditional on a stockout',X[mask],eta[mask],g[mask],INV_FEATURES,'hours',baseline=np.minimum(ledger[mask],6),extra={'scope':'Regression fitted and scored only on observed stockouts. Non-stockout windows are censored and excluded. Runtime displays an ETA when the risk classifier predicts stockout.'})
X,event,eta,g,ledger=inventory_dataset(True)
train_task('depot_runway','Depot time to shortage within six hours',X,eta,g,INV_FEATURES,'hours',baseline=ledger,extra={'scope':'Synthetic depot inventory and dated replenishment scenarios. Target is capped at 6.25 h when no shortage occurs within the six-hour window. Larger reserves are represented in training.','censorValue':6.25})
X,y,g,baseline=network_dataset()
train_task('network_runway','Network time to depletion within 96 hours',X,y,g,NETWORK_FEATURES,'hours',baseline=baseline,extra={'scope':'Aggregate synthetic fuel network, dated supply and uncertain demand. Six-hour forecast rate held constant beyond its horizon; target capped at 96.25 h.','censorValue':96.25})
X,y,g,baseline=transport_dataset()
train_task('transport_delay','Additional transport delay beyond nominal route time',X,y,g,TRANS_FEATURES,'ticks',baseline=baseline,extra={'scope':'Assumed synthetic traffic/reliability patterns, not observed road data. Official simulator nominal and scheduled arrival times remain authoritative. Validation does not establish operational transport accuracy.'})
report={'version':VERSION,'library':'scikit-learn '+sklearn.__version__,'modelCount':15,'taskCount':5,'dataset':'Synthetic supervised outcome datasets; all episode seeds are disjoint across training, validation and test. Validation determines ensemble weights and residual intervals. No test fitting.','limitations':['These results measure synthetic surrogate outcomes, not real-world or official-simulator outcome accuracy.','Stockout timing is conditional on a shortage; depot and network runway have explicit censoring horizons.','Transport delay labels are assumed synthetic patterns; nominal simulator timing remains the known schedule.','Shipment impact is a model-based counterfactual, not experimentally measured causal impact.'],'tasks':list(reports.values())}
raw=json.dumps({'version':VERSION,'tasks':artifacts,'report':report},separators=(',',':'));(ROOT/'apps/api/src/forecast/operational-models.json').write_text(raw);report['artifactSha256']=hashlib.sha256(raw.encode()).hexdigest()
(OUT/'evaluation.json').write_text(json.dumps(report,indent=2));(PUBLIC/'operational-evaluation.json').write_text(json.dumps(report));(ROOT/'apps/api/src/forecast/operational-fixtures.json').write_text(json.dumps(fixtures))
plt.style.use('seaborn-v0_8-whitegrid');fig,ax=plt.subplots(2,3,figsize=(17,10));risk=reports['stockout_probability'];cm=risk['ensemble']['matrix'];ax[0,0].imshow(cm,cmap='Blues');ax[0,0].set(xticks=[0,1],yticks=[0,1],xticklabels=['No shortage','Shortage'],yticklabels=['No shortage','Shortage'],xlabel='Predicted',ylabel='Actual',title='Trained stockout classifier')
for i in range(2):
 for j in range(2):ax[0,0].text(j,i,str(cm[i][j]),ha='center',va='center',fontsize=20)
cal=risk['calibration'];ax[0,1].plot([x['predicted'] for x in cal],[x['observed'] for x in cal],marker='o');ax[0,1].plot([0,1],[0,1],'--',color='gray');ax[0,1].set(title='Held-out risk calibration',xlabel='Predicted probability',ylabel='Observed event frequency')
for axis,key in zip([ax[0,2],ax[1,0],ax[1,1],ax[1,2]],['stockout_time','depot_runway','network_runway','transport_delay']):
 r=reports[key];axis.barh([m['model'] for m in r['metrics']],[m['mae'] for m in r['metrics']],color=['#2563eb']*3+['#059669','#94a3b8']);axis.set_title(r['label'],fontsize=10);axis.set_xlabel('MAE ('+r['unit']+')')
fig.suptitle('Separate trained operational predictors — held-out SYNTHETIC evidence',fontsize=16);fig.tight_layout();fig.savefig(OUT/'evaluation.png',dpi=150);fig.savefig(OUT/'evaluation.pdf');fig.savefig(PUBLIC/'operational-evaluation.png',dpi=120)
print('Wrote',len(raw)//1000000,'MB artifact with 15 trained estimators across 5 tasks',flush=True)
