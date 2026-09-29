"""Reproducible supervised tree ensemble. Synthetic episode split; no test fitting.
Run: python scripts/ml/train.py. Runtime uses exported trees, no Python service.
"""
from pathlib import Path
import json, hashlib, gzip, csv, sys
import numpy as np
from sklearn.ensemble import RandomForestRegressor, ExtraTreesRegressor, GradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score, confusion_matrix, precision_score, recall_score, f1_score
import sklearn
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/evidence/ml'; OUT.mkdir(parents=True,exist_ok=True)
DAILY=np.array([[8500,10500,5600],[14000,4500,2200],[10500,11000,6200],[7200,7600,3600]])
NOISE=[.10,.08,.12,.10]
NAMES=['hour_sin','hour_cos','hour','urban','industrial','highway','regional','diesel','petrol','octane','multiplier','lag_level','level_4','level_12','horizon']
def factor(p,h):
 if p==0:return 1.45 if 7<=h<10 or 16<=h<21 else .7
 if p==1:return 1.55 if 6<=h<18 else .45
 if p==2:return 1.35 if 6<=h<10 or 16<=h<21 else .75
 return 1.25 if 7<=h<21 else .65
def features(p,f,h,m,levels,k):
 return [np.sin(h*np.pi/12),np.cos(h*np.pi/12),h,*[int(p==j) for j in range(4)],*[int(f==j) for j in range(3)],m,levels[-1],np.mean(levels[-4:]),np.mean(levels[-12:]),k]
rows=[]; groups=[]; targets=[]; scales=[]; baselines=[]; series=[]
for episode in range(144):
 rng=np.random.default_rng(17000+episode); p=episode%4; f=(episode//4)%3
 region=1.08 if p>=2 else 1.; scale=DAILY[p,f]/96*region
 multipliers=np.ones(216); start=int(rng.integers(35,130)); length=int(rng.integers(20,65)); multipliers[start:start+length]=rng.uniform(1.4,2.5)
 latent=rng.uniform(.85,1.15); noise=rng.normal(0,NOISE[p],216)
 demand=np.array([scale*factor(p,(t%96)//4)*multipliers[t]*latent*max(.1,1+noise[t]) for t in range(216)])
 levels=np.array([demand[t]/(scale*factor(p,(t%96)//4)) for t in range(216)])
 for origin in range(24,181,12):
  for k in range(1,25):
   t=origin+k; h=(t%96)//4
   rows.append(features(p,f,h,multipliers[origin],levels[origin-23:origin+1],k)); targets.append(demand[t]/scale); scales.append(scale); groups.append(episode); series.append((episode,origin,k))
   baselines.append(factor(p,h)*np.mean(levels[origin-11:origin+1]))
X=np.asarray(rows,dtype=np.float32); y=np.array(targets); scale=np.array(scales); groups=np.array(groups); baseline=np.array(baselines)
train=groups<96; val=(groups>=96)&(groups<120); test=groups>=120
print('Training',len(X),'rows',flush=True)
models={
 'Random Forest':RandomForestRegressor(n_estimators=48,max_depth=11,min_samples_leaf=8,n_jobs=2,random_state=42),
 'Extra Trees':ExtraTreesRegressor(n_estimators=48,max_depth=12,min_samples_leaf=6,n_jobs=2,random_state=42),
 'Gradient Boosting':GradientBoostingRegressor(n_estimators=110,max_depth=3,min_samples_leaf=12,learning_rate=.07,loss='huber',random_state=42)}
validation={}; predictions={}; trees=[]
def export_tree(t):
 a=t.tree_
 return {'left':a.children_left.tolist(),'right':a.children_right.tolist(),'feature':a.feature.tolist(),'threshold':np.round(a.threshold,8).tolist(),'value':np.round(a.value[:,0,0],8).tolist()}
for name,m in models.items():
 m.fit(X[train],y[train]); validation[name]=mean_absolute_error(y[val]*scale[val],m.predict(X[val])*scale[val]); predictions[name]=m.predict(X[test])*scale[test]
 if name=='Gradient Boosting': payload={'name':name,'kind':'boost','base':float(m.init_.constant_[0,0]),'rate':m.learning_rate,'trees':[export_tree(t[0]) for t in m.estimators_]}
 else: payload={'name':name,'kind':'forest','base':0,'rate':1/len(m.estimators_),'trees':[export_tree(t) for t in m.estimators_]}
 trees.append(payload); print(name,'validation MAE',round(validation[name],3),flush=True)
w=np.array([1/validation[n] for n in models]); w=w/w.sum()
ensemble=sum(w[i]*predictions[n] for i,n in enumerate(models)); predictions['Trained ensemble']=ensemble; predictions['Seasonal baseline']=baseline[test]*scale[test]
actual=y[test]*scale[test]
metrics=[]
for name,pred in predictions.items():
 metrics.append({'model':name,'mae':float(mean_absolute_error(actual,pred)),'rmse':float(np.sqrt(mean_squared_error(actual,pred))),'r2':float(r2_score(actual,pred)),'wape':float(np.sum(np.abs(actual-pred))/np.sum(actual))})
val_pred=sum(w[i]*m.predict(X[val]) for i,m in enumerate(models.values()))
relative=np.abs(y[val]-val_pred)/np.maximum(val_pred,.1); q=float(np.quantile(relative,.9)); cv=float(np.sqrt(np.mean(relative**2)))
# Each contiguous 24 rows is a full 6h forecast; inventories use baseline only.
rng=np.random.default_rng(991); actual6=actual.reshape(-1,24).sum(axis=1); predicted6=ensemble.reshape(-1,24).sum(axis=1)
inventory=(baseline[test]*scale[test]).reshape(-1,24).sum(axis=1)*rng.uniform(.4,1.6,len(actual6))
ytrue=actual6>inventory; ypred=predicted6>inventory
cm=confusion_matrix(ytrue,ypred,labels=[False,True]).tolist()
classification={'matrix':cm,'precision':float(precision_score(ytrue,ypred,zero_division=0)),'recall':float(recall_score(ytrue,ypred,zero_division=0)),'f1':float(f1_score(ytrue,ypred,zero_division=0)),'accuracy':float(np.mean(ytrue==ypred)),'samples':len(actual6),'positiveRate':float(np.mean(ytrue)),'definition':'No new deliveries: stockout if total six-hour demand exceeds starting inventory. Derived from the regressor; not a separately trained classifier.'}
feature_importance=sum(w[i]*m.feature_importances_ for i,m in enumerate(models.values()))
report={'version':'trained-tree-ensemble-1.0.0','library':'scikit-learn '+sklearn.__version__,'dataset':'Synthetic fuel-demand episodes using organizer seasonal profiles, random demand surges, latent station variation and demand noise. Not real-world or official-simulator test results.','seed':17000,'split':{'trainEpisodes':96,'validationEpisodes':24,'testEpisodes':24,'trainRows':int(train.sum()),'validationRows':int(val.sum()),'testRows':int(test.sum()),'method':'Whole episodes with distinct seeds; validation determines weights and residual bounds; test is never used for fitting or selection.'},'weights':dict(zip(models,map(float,w))),'validationMae':validation,'metrics':metrics,'stockout':classification,'relative90Bound':q,'relativeRmse':cv,'features':NAMES,'featureImportance':dict(zip(NAMES,map(float,feature_importance))),'intervalCoverage':float(np.mean(np.abs(actual-ensemble)<=ensemble*q)),'limitations':['Synthetic held-out performance does not establish real-world accuracy.','Future unannounced demand-event starts and ends are unknown to forecasts.','Risk probability remains a planning approximation; confidence is not an LLM reasoning score.'],'sample':[{'actual':float(a),'predicted':float(b)} for a,b in zip(actual[:144],ensemble[:144])]}
artifact={'version':report['version'],'features':NAMES,'models':trees,'weights':list(map(float,w)),'relative90Bound':q,'relativeRmse':cv,'report':report}
raw=json.dumps(artifact,separators=(',',':')); path=ROOT/'apps/api/src/forecast/trained-model.json';path.write_text(raw)
report['artifactSha256']=hashlib.sha256(raw.encode()).hexdigest()
(OUT/'evaluation.json').write_text(json.dumps(report,indent=2))
(ROOT/'apps/web/public/ml/evaluation.json').write_text(json.dumps(report))
# Export reproducible dataset for judges.
with gzip.open(OUT/'synthetic-dataset.csv.gz','wt') as fp:
 writer=csv.writer(fp);writer.writerow(['episode','split',*NAMES,'demand_liters']);
 for i,row in enumerate(X):writer.writerow([int(groups[i]),'train' if train[i] else 'validation' if val[i] else 'test',*row.tolist(),float(y[i]*scale[i])])
plt.style.use('seaborn-v0_8-whitegrid');fig,ax=plt.subplots(2,2,figsize=(14,10))
names=[m['model'] for m in metrics];ax[0,0].barh(names,[m['mae'] for m in metrics],color=['#2563eb']*3+['#059669','#94a3b8']);ax[0,0].set_title('Held-out MAE (litres per 15-minute tick)')
ax[0,1].plot(actual[:144],label='Actual',color='#0f172a');ax[0,1].plot(ensemble[:144],label='Ensemble',color='#2563eb');ax[0,1].set_title('Six consecutive held-out 6h forecast windows');ax[0,1].legend()
ax[1,0].scatter(actual[::8],ensemble[::8],s=7,alpha=.25);mx=max(actual.max(),ensemble.max());ax[1,0].plot([0,mx],[0,mx],'--',color='black');ax[1,0].set(xlabel='Actual litres',ylabel='Predicted litres',title='Predicted versus actual')
ax[1,1].imshow(cm,cmap='Blues');ax[1,1].set(xticks=[0,1],yticks=[0,1],xticklabels=['No stockout','Stockout'],yticklabels=['No stockout','Stockout'],xlabel='Predicted',ylabel='Actual',title=f"6h stockout confusion matrix · F1 {classification['f1']:.3f}")
for i in range(2):
 for j in range(2):ax[1,1].text(j,i,str(cm[i][j]),ha='center',va='center',fontsize=24)
fig.suptitle('Trained fuel forecast ensemble — held-out SYNTHETIC evaluation',fontsize=16);fig.tight_layout();fig.savefig(OUT/'evaluation.png',dpi=160);fig.savefig(OUT/'evaluation.pdf');fig.savefig(ROOT/'apps/web/public/ml/evaluation.png',dpi=120)
print(json.dumps({'metrics':metrics,'stockout':classification,'artifactMB':len(raw)/1e6},indent=2))

(ROOT/'apps/api/src/forecast/trained-fixtures.json').write_text(json.dumps([{'features':row.tolist(),'expected':float(pred/scale[test][k])} for k,(row,pred) in enumerate(zip(X[test][:24],ensemble[:24]))]))
