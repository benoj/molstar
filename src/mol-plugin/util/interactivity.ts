/**
 * Copyright (c) 2019 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 * @author David Sehnal <david.sehnal@gmail.com>
 */

import { Loci as ModelLoci, EmptyLoci, EveryLoci, isEmptyLoci } from '../../mol-model/loci';
import { ModifiersKeys, ButtonsType } from '../../mol-util/input/input-observer';
import { Representation } from '../../mol-repr/representation';
import { StructureElement, Link } from '../../mol-model/structure';
import { MarkerAction } from '../../mol-util/marker-action';
import { StructureElementSelectionManager } from './structure-element-selection';
import { PluginContext } from '../context';
import { StructureElement as SE, Structure } from '../../mol-model/structure';
import { ParamDefinition as PD } from '../../mol-util/param-definition';
import { PluginCommands } from '../command';
import { capitalize } from '../../mol-util/string';

export { Interactivity }

class Interactivity {
    readonly lociSelects: Interactivity.LociSelectManager;
    readonly lociHighlights: Interactivity.LociHighlightManager;

    private _props = PD.getDefaultValues(Interactivity.Params)

    get props() { return { ...this._props } }
    setProps(props: Partial<Interactivity.Props>) {
        Object.assign(this._props, props)
        this.lociSelects.setProps(this._props)
        this.lociHighlights.setProps(this._props)
    }

    constructor(readonly ctx: PluginContext, props: Partial<Interactivity.Props> = {}) {
        Object.assign(this._props, props)

        this.lociSelects = new Interactivity.LociSelectManager(ctx, this._props);
        this.lociHighlights = new Interactivity.LociHighlightManager(ctx, this._props);

        PluginCommands.Interactivity.SetProps.subscribe(ctx, e => this.setProps(e.props));
    }
}

namespace Interactivity {
    export interface Loci<T extends ModelLoci = ModelLoci> { loci: T, repr?: Representation.Any }

    export namespace Loci {
        export function areEqual(a: Loci, b: Loci) {
            return a.repr === b.repr && ModelLoci.areEqual(a.loci, b.loci);
        }
        export const Empty: Loci = { loci: EmptyLoci };
    }

    const Granularity = {
        'element': (loci: ModelLoci) => loci,
        'residue': (loci: ModelLoci) => SE.Loci.is(loci) ? SE.Loci.extendToWholeResidues(loci) : loci,
        'chain': (loci: ModelLoci) => SE.Loci.is(loci) ? SE.Loci.extendToWholeChains(loci) : loci,
        'structure': (loci: ModelLoci) => SE.Loci.is(loci) ? Structure.Loci(loci.structure) : loci
    }
    type Granularity = keyof typeof Granularity
    const GranularityOptions = Object.keys(Granularity).map(n => [n, capitalize(n)]) as [Granularity, string][]

    export const Params = {
        granularity: PD.Select('residue', GranularityOptions, { description: 'Controls if selections are expanded to whole residues, chains, structures, or left as atoms and coarse elements' }),
    }
    export type Params = typeof Params
    export type Props = PD.Values<Params>

    export interface HoverEvent { current: Loci, buttons: ButtonsType, modifiers: ModifiersKeys }
    export interface ClickEvent { current: Loci, buttons: ButtonsType, modifiers: ModifiersKeys }

    export type LociMarkProvider = (loci: Loci, action: MarkerAction) => void

    export abstract class LociMarkManager {
        protected providers: LociMarkProvider[] = [];
        protected sel: StructureElementSelectionManager

        readonly props: Readonly<Props> = PD.getDefaultValues(Params)

        setProps(props: Partial<Props>) {
            Object.assign(this.props, props)
        }

        addProvider(provider: LociMarkProvider) {
            this.providers.push(provider);
        }

        removeProvider(provider: LociMarkProvider) {
            this.providers = this.providers.filter(p => p !== provider);
            // TODO clear, then re-apply remaining providers
        }

        normalizedLoci(interactivityLoci: Loci, applyGranularity = true) {
            let { loci, repr } = interactivityLoci
            if (this.props.granularity !== 'element' && Link.isLoci(loci)) {
                // convert Link.Loci to a StructureElement.Loci so granularity can be applied
                loci = Link.toStructureElementLoci(loci)
            }
            if (Structure.isLoci(loci)) {
                // convert to StructureElement.Loci
                loci = Structure.toStructureElementLoci(loci)
            }
            if (StructureElement.Loci.is(loci)) {
                // ensure the root structure is used
                loci = StructureElement.Loci.remap(loci, loci.structure.root)
            }
            if (applyGranularity) {
                // needs to be applied AFTER remapping to root
                loci = Granularity[this.props.granularity](loci)
            }
            return { loci, repr }
        }

        protected mark(current: Loci<ModelLoci>, action: MarkerAction) {
            for (let p of this.providers) p(current, action);
        }

        constructor(public readonly ctx: PluginContext, props: Partial<Props> = {}) {
            this.sel = ctx.helpers.structureSelectionManager
            this.setProps(props)
        }
    }

    //

    export class LociHighlightManager extends LociMarkManager {
        private prev: Loci = { loci: EmptyLoci, repr: void 0 };

        highlightOnly(current: Loci, applyGranularity = true) {
            const normalized = this.normalizedLoci(current, applyGranularity)
            if (StructureElement.Loci.is(normalized.loci)) {
                const loci = normalized.loci;
                this.mark(this.prev, MarkerAction.RemoveHighlight);
                const toHighlight = { loci, repr: normalized.repr };
                this.mark(toHighlight, MarkerAction.Highlight);
                this.prev = toHighlight;
            } else {
                if (!Loci.areEqual(this.prev, normalized)) {
                    this.mark(this.prev, MarkerAction.RemoveHighlight);
                    this.mark(normalized, MarkerAction.Highlight);
                    this.prev = normalized;
                }
            }
        }

        highlightOnlyExtend(current: Loci, applyGranularity = true) {
            const normalized = this.normalizedLoci(current, applyGranularity)
            if (StructureElement.Loci.is(normalized.loci)) {
                const loci = this.sel.tryGetRange(normalized.loci) || normalized.loci;
                this.mark(this.prev, MarkerAction.RemoveHighlight);
                const toHighlight = { loci, repr: normalized.repr };
                this.mark(toHighlight, MarkerAction.Highlight);
                this.prev = toHighlight;
            }
        }
    }

    //

    export class LociSelectManager extends LociMarkManager {
        selectToggle(current: Loci<ModelLoci>, applyGranularity = true) {
            const normalized = this.normalizedLoci(current, applyGranularity)
            if (StructureElement.Loci.is(normalized.loci)) {
                this.toggleSel(normalized);
            } else {
                this.mark(normalized, MarkerAction.Toggle);
            }
        }

        selectExtend(current: Loci<ModelLoci>, applyGranularity = true) {
            const normalized = this.normalizedLoci(current, applyGranularity)
            if (StructureElement.Loci.is(normalized.loci)) {
                const loci = this.sel.tryGetRange(normalized.loci) || normalized.loci;
                this.toggleSel({ loci, repr: normalized.repr });
            }
        }

        select(current: Loci<ModelLoci>, applyGranularity = true) {
            const normalized = this.normalizedLoci(current, applyGranularity)
            if (StructureElement.Loci.is(normalized.loci)) {
                this.sel.add(normalized.loci);
            }
            this.mark(normalized, MarkerAction.Select);
        }

        selectOnly(current: Loci<ModelLoci>, applyGranularity = true) {
            this.deselectAll()
            const normalized = this.normalizedLoci(current, applyGranularity)
            if (StructureElement.Loci.is(normalized.loci)) {
                this.sel.set(normalized.loci);
            }
            this.mark(normalized, MarkerAction.Select);
        }

        deselect(current: Loci<ModelLoci>, applyGranularity = true) {
            const normalized = this.normalizedLoci(current, applyGranularity)
            if (StructureElement.Loci.is(normalized.loci)) {
                this.sel.remove(normalized.loci);
            }
            this.mark(normalized, MarkerAction.Deselect);
        }

        deselectAll() {
            this.sel.clear();
            this.mark({ loci: EveryLoci }, MarkerAction.Deselect);
        }

        deselectAllOnEmpty(current: Loci<ModelLoci>) {
            if (isEmptyLoci(current.loci)) this.deselectAll()
        }

        private toggleSel(current: Loci<ModelLoci>) {
            if (this.sel.has(current.loci)) {
                this.sel.remove(current.loci);
                this.mark(current, MarkerAction.Deselect);
            } else {
                this.sel.add(current.loci);
                this.mark(current, MarkerAction.Select);
            }
        }
    }
}