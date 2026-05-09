# Search And Recommendation

Search is user-triggered.

1. Search local candidate metadata cache.
2. Merge local matches from followed UP creators.
3. Merge local favorites from the App library.
4. If requested, call the configured provider with strict timeout and limit.
5. If followed UP creators exist, run a tiny user-triggered followed-UP expansion for the top creators.
6. Normalize provider results into sanitized `CandidateVideo` metadata.
7. Upsert metadata into SQLite.
8. Rank candidates with an explicit score breakdown.

Pagination is explicit and user-triggered. The App accepts a bounded `page` value, passes it to Bilibili/kernel providers, and shows `上一页` / `下一页` controls instead of infinite scrolling.

## Ranking Breakdown

```json
{
  "textMatch": 30,
  "preferredCreator": 50,
  "musicLikelihood": 20,
  "recency": 5,
  "interaction": 0,
  "penalty": -10,
  "final": 95
}
```

Followed UP creators receive a strong boost based on `priorityWeight`.

Favorites receive an interaction boost in search ranking. The visible discovery page now uses 收藏 as the primary library surface instead of a separate recommendation pool. This is local App state only; it does not operate on Bilibili favorites.

Music likelihood considers:

- Positive words such as `原创曲`, `翻唱`, `cover`, `MV`, `歌曲`, `音乐`, `live`, `vocal`, `instrumental`.
- Negative words such as `教程`, `解析`, `reaction`, `评测`, `直播回放`, `课程`, `新闻`.
- Music category hints.
- Duration between about 1 and 12 minutes.

Recommendations use cached metadata only and do not trigger remote crawling.
