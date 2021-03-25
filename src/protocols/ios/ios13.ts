import { IOS12Protocol } from './ios12';
import { Target } from '../target';

export class IOS13Protocol extends IOS12Protocol {

    constructor(target: Target) {
        super(target);
        target.targetBased = false;
    }

    public onRuntimeGetProperties(msg: any): Promise<any> {
        try {
            const newPropertyDescriptors = [];

            let { properties } = msg.result;

            if (!properties) {
                properties = msg.result;
            }

            for (let i = 0; i < properties.length; i++) {
                if (properties[i].isOwn || properties[i].nativeGetter) {
                    properties[i].isOwn = true;
                    newPropertyDescriptors.push(properties[i]);
                }
            }
            msg.result = null;
            msg.result = { result: newPropertyDescriptors };

            return Promise.resolve(msg);
        } catch (error) {
            console.log(error);
            console.log(msg);
        }

        return Promise.resolve({});
    }
}
