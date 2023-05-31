import { EventInput } from '@fullcalendar/core'
import { EventSourceDef, DateRange, addDays } from '@fullcalendar/core/internal'
import * as ICAL from 'ical.js'
import { IcalExpander } from './ical-expander/IcalExpander.js'
import { DateTime } from 'luxon'

interface ICalFeedMeta {
  url: string
  format: 'ics'
  headers: any
  internalState?: InternalState // HACK. TODO: use classes in future
}

interface InternalState {
  iCalExpanderPromise: Promise<IcalExpander>
  response: Response | null
}

export const eventSourceDef: EventSourceDef<ICalFeedMeta> = {
  parseMeta(refined) {
    if (refined.url && refined.format === 'ics') {
      return {
        url: refined.url,
        format: 'ics',
        headers: refined.extraParams['headers'],
      }
    }
    return null
  },

  fetch(arg, successCallback, errorCallback) {
    let meta: ICalFeedMeta = arg.eventSource.meta
    let { internalState, headers } = meta

    /*
    NOTE: isRefetch is a HACK. we would do the recurring-expanding in a separate plugin hook,
    but we couldn't leverage built-in allDay-guessing, among other things.
    */
    if (!internalState || arg.isRefetch) {
      internalState = meta.internalState = {
        response: null,
        iCalExpanderPromise: fetch(meta.url, { method: 'GET', headers }).then(
          (response) => {
            return response.text().then((icsText) => {
              internalState.response = response
              return new IcalExpander({
                ics: icsText,
                skipInvalidDates: true,
              })
            })
          },
        ),
      }
    }

    internalState.iCalExpanderPromise.then((iCalExpander) => {
      successCallback({
        rawEvents: expandICalEvents(iCalExpander, arg.range),
        response: internalState.response,
      })
    }, errorCallback)
  },
}

function expandICalEvents(
  iCalExpander: IcalExpander,
  range: DateRange,
): EventInput[] {
  // expand the range. because our `range` is timeZone-agnostic UTC
  // or maybe because ical.js always produces dates in local time? i forget
  let rangeStart = addDays(range.start, -1)
  let rangeEnd = addDays(range.end, 1)

  let iCalRes = iCalExpander.between(rangeStart, rangeEnd) // end inclusive. will give extra results
  let expanded: EventInput[] = []

  // TODO: instead of using startDate/endDate.toString to communicate allDay,
  // we can query startDate/endDate.isDate. More efficient to avoid formatting/reparsing.

  // single events
  for (let iCalEvent of iCalRes.events) {
    const startDate = DateTime.fromFormat(
      iCalEvent.startDate.toString(),
      'yyyy-MM-dd\'T\'HH:mm:ss',
      { zone: 'utc' }
    ).setZone(iCalEvent.startDate.timezone)
    const endDate = DateTime.fromFormat(
      iCalEvent.endDate.toString(),
      'yyyy-MM-dd\'T\'HH:mm:ss',
      { zone: 'utc' }
    ).setZone(iCalEvent.endDate.timezone)
    expanded.push({
      ...buildNonDateProps(iCalEvent),
      start: startDate.toJSDate(),
      end: specifiesEnd(iCalEvent) && iCalEvent.endDate ? endDate.toJSDate() : null,
    })
  }

  // recurring event instances
  for (let iCalOccurence of iCalRes.occurrences) {
    const startDate = DateTime.fromFormat(
      iCalOccurence.startDate.toString(),
      'yyyy-MM-dd\'T\'HH:mm:ss',
      { zone: 'utc' }
    ).setZone(iCalOccurence.startDate.timezone)
    const endDate = DateTime.fromFormat(
      iCalOccurence.endDate.toString(),
      'yyyy-MM-dd\'T\'HH:mm:ss',
      { zone: 'utc' }
    ).setZone(iCalOccurence.endDate.timezone)
    let iCalEvent = iCalOccurence.item
    expanded.push({
      ...buildNonDateProps(iCalEvent),
      start: startDate.toJSDate(),
      end: specifiesEnd(iCalEvent) && iCalOccurence.endDate ? endDate.toJSDate() : null,
    })
  }

  return expanded
}

function buildNonDateProps(iCalEvent: ICAL.Event): EventInput {
  const commonProps = [
    'uid',
    'summary',
    'url',
    'location',
    'organizer',
    'description',
  ]
  const result = {
    id: iCalEvent.uid,
    title: iCalEvent.summary,
    url: extractEventUrl(iCalEvent),
    extendedProps: {
      location: iCalEvent.location,
      organizer: iCalEvent.organizer,
      description: iCalEvent.description,
    },
  }
  for (const prop in iCalEvent) {
    if (commonProps.indexOf(prop) < 0) {
      result.extendedProps[prop] = iCalEvent[prop]
    }
  }
  return result
}

function extractEventUrl(iCalEvent: ICAL.Event): string {
  let urlProp = iCalEvent.component.getFirstProperty('url')
  return urlProp ? urlProp.getFirstValue() : ''
}

function specifiesEnd(iCalEvent: ICAL.Event) {
  return (
    Boolean(iCalEvent.component.getFirstProperty('dtend')) ||
    Boolean(iCalEvent.component.getFirstProperty('duration'))
  )
}
